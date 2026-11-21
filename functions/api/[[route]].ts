interface Env {
  DATABASE_URL?: string;
  ADMIN_PASSWORD?: string;
  STRIPE_SECRET_KEY?: string;
}

async function runSql(databaseUrl: string, query: string, params: any[] = []) {
  const url = new URL(databaseUrl);
  const endpoint = `https://${url.hostname}/sql`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": databaseUrl,
    },
    body: JSON.stringify({ query, params }),
  });

  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || data?.error || "Erreur SQL Neon");
  }
  return data.rows || [];
}

async function ensureTables(dbUrl: string) {
  await runSql(
    dbUrl,
    `CREATE TABLE IF NOT EXISTS custom_products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      format TEXT NOT NULL,
      price_m2 NUMERIC NOT NULL,
      stock_m2 NUMERIC NOT NULL,
      image_url TEXT,
      seo_description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`
  );
  await runSql(dbUrl, `ALTER TABLE custom_products ADD COLUMN IF NOT EXISTS seo_description TEXT`);
  await runSql(
    dbUrl,
    `CREATE TABLE IF NOT EXISTS quote_requests (
      id SERIAL PRIMARY KEY,
      client_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      city TEXT NOT NULL,
      surface_m2 NUMERIC NOT NULL,
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`
  );
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  if (path === "/health" && method === "GET") {
    let dbOk = false;
    if (env.DATABASE_URL) {
      try {
        await runSql(env.DATABASE_URL, "SELECT 1");
        dbOk = true;
      } catch {
        dbOk = false;
      }
    }
    return json({
      ok: true,
      database: dbOk,
      adminConfigured: Boolean(env.ADMIN_PASSWORD),
      stripeConfigured: Boolean(env.STRIPE_SECRET_KEY),
    });
  }

  if (path === "/products" && method === "GET") {
    if (!env.DATABASE_URL) return json({ products: [] });
    try {
      await ensureTables(env.DATABASE_URL);
      const rows = await runSql(env.DATABASE_URL, "SELECT * FROM custom_products ORDER BY id DESC");
      return json({ products: rows });
    } catch (err: any) {
      return json({ products: [], error: err.message }, 500);
    }
  }

  if (path === "/admin/login" && method === "POST") {
    const body: any = await request.json().catch(() => ({}));
    if (!env.ADMIN_PASSWORD) {
      return json({ ok: false, error: "Variable ADMIN_PASSWORD manquante sur Cloudflare." }, 503);
    }
    if ((body.password || "").trim() !== env.ADMIN_PASSWORD.trim()) {
      return json({ ok: false, error: "Mot de passe gérant incorrect." }, 401);
    }
    return json({ ok: true });
  }

  if (path === "/products" && method === "POST") {
    const body: any = await request.json().catch(() => ({}));
    if (!env.ADMIN_PASSWORD || (body.password || "").trim() !== env.ADMIN_PASSWORD.trim()) {
      return json({ ok: false, error: "Non autorisé." }, 401);
    }
    if (!env.DATABASE_URL) {
      return json({ ok: false, error: "DATABASE_URL non configurée sur Cloudflare." }, 503);
    }
    try {
      await ensureTables(env.DATABASE_URL);
      const rows = await runSql(
        env.DATABASE_URL,
        `INSERT INTO custom_products (name, category, format, price_m2, stock_m2, image_url, seo_description)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          body.name,
          body.category,
          body.format,
          Number(body.price_m2),
          Number(body.stock_m2),
          body.image_url || "",
          body.seo_description || "",
        ]
      );
      return json({ ok: true, product: rows[0] });
    } catch (err: any) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  const prodMatch = path.match(/^\/products\/(\d+)$/);
  if (prodMatch && method === "PUT") {
    const id = Number(prodMatch[1]);
    const body: any = await request.json().catch(() => ({}));
    if (!env.ADMIN_PASSWORD || (body.password || "").trim() !== env.ADMIN_PASSWORD.trim()) {
      return json({ ok: false, error: "Non autorisé." }, 401);
    }
    if (!env.DATABASE_URL) {
      return json({ ok: false, error: "DATABASE_URL non configurée sur Cloudflare." }, 503);
    }
    try {
      await ensureTables(env.DATABASE_URL);
      const rows = await runSql(
        env.DATABASE_URL,
        `UPDATE custom_products
         SET name = $1, category = $2, format = $3, price_m2 = $4, stock_m2 = $5, image_url = $6, seo_description = $7
         WHERE id = $8 RETURNING *`,
        [
          body.name,
          body.category,
          body.format,
          Number(body.price_m2),
          Number(body.stock_m2),
          body.image_url || "",
          body.seo_description || "",
          id,
        ]
      );
      return json({ ok: true, product: rows[0] });
    } catch (err: any) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  if (prodMatch && method === "DELETE") {
    const id = Number(prodMatch[1]);
    const body: any = await request.json().catch(() => ({}));
    if (!env.ADMIN_PASSWORD || (body.password || "").trim() !== env.ADMIN_PASSWORD.trim()) {
      return json({ ok: false, error: "Non autorisé." }, 401);
    }
    if (!env.DATABASE_URL) {
      return json({ ok: false, error: "DATABASE_URL non configurée sur Cloudflare." }, 503);
    }
    try {
      await ensureTables(env.DATABASE_URL);
      await runSql(env.DATABASE_URL, "DELETE FROM custom_products WHERE id = $1", [id]);
      return json({ ok: true });
    } catch (err: any) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  if (path === "/quotes" && method === "POST") {
    const body: any = await request.json().catch(() => ({}));
    if (!env.DATABASE_URL) return json({ ok: true, localOnly: true });
    try {
      await ensureTables(env.DATABASE_URL);
      await runSql(
        env.DATABASE_URL,
        `INSERT INTO quote_requests (client_name, phone, city, surface_m2, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [body.client_name, body.phone, body.city, Number(body.surface_m2 || 0), body.details || ""]
      );
      return json({ ok: true });
    } catch (err: any) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  if (path === "/checkout" && method === "POST") {
    if (!env.STRIPE_SECRET_KEY) {
      return json({ ok: false, error: "Variable STRIPE_SECRET_KEY manquante sur Cloudflare." }, 503);
    }
    const body: any = await request.json().catch(() => ({}));
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) {
      return json({ ok: false, error: "Votre panier est vide." }, 400);
    }

    const origin = url.origin;
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", `${origin}/?commande=validee`);
    params.append("cancel_url", `${origin}/?commande=annulee`);

    items.forEach((item: any, i: number) => {
      params.append(`line_items[${i}][price_data][currency]`, "eur");
      params.append(`line_items[${i}][price_data][product_data][name]`, item.name);
      params.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(Number(item.totalPrice) * 100)));
      params.append(`line_items[${i}][quantity]`, "1");
    });

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY.trim()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session: any = await res.json();
    if (!res.ok) {
      return json({ ok: false, error: session?.error?.message || "Erreur Stripe" }, 400);
    }
    return json({ ok: true, url: session.url });
  }

  return json({ error: "Route introuvable" }, 404);
};
