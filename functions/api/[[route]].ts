import { Hono } from "hono";
import { handle } from "hono/cloudflare-pages";
import { neon } from "@neondatabase/serverless";

type Bindings = {
  DATABASE_URL?: string;
  ADMIN_PASSWORD?: string;
  STRIPE_SECRET_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>().basePath("/api");

async function ensureTables(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS custom_products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      format TEXT NOT NULL,
      price_m2 NUMERIC NOT NULL,
      stock_m2 NUMERIC NOT NULL,
      image_url TEXT,
      seo_description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE custom_products ADD COLUMN IF NOT EXISTS seo_description TEXT`;

  await sql`
    CREATE TABLE IF NOT EXISTS quote_requests (
      id SERIAL PRIMARY KEY,
      client_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      city TEXT NOT NULL,
      surface_m2 NUMERIC NOT NULL,
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
}

// 1. Santé des services
app.get("/health", async (c) => {
  let dbOk = false;
  if (c.env.DATABASE_URL) {
    try {
      const sql = neon(c.env.DATABASE_URL);
      await sql`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
  }
  return c.json({
    ok: true,
    database: dbOk,
    adminConfigured: Boolean(c.env.ADMIN_PASSWORD),
    stripeConfigured: Boolean(c.env.STRIPE_SECRET_KEY),
  });
});

// 2. Liste des produits depuis Neon (uniquement vos produits)
app.get("/products", async (c) => {
  if (!c.env.DATABASE_URL) {
    return c.json({ products: [] });
  }
  try {
    const sql = neon(c.env.DATABASE_URL);
    await ensureTables(sql);
    const rows = await sql`SELECT * FROM custom_products ORDER BY id DESC`;
    return c.json({ products: rows });
  } catch (err: any) {
    return c.json({ products: [], error: err.message }, 500);
  }
});

// 3. Connexion Accès Gérant
app.post("/admin/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!c.env.ADMIN_PASSWORD) {
    return c.json({ ok: false, error: "Variable ADMIN_PASSWORD manquante sur Cloudflare." }, 503);
  }
  if ((body.password || "").trim() !== c.env.ADMIN_PASSWORD.trim()) {
    return c.json({ ok: false, error: "Mot de passe gérant incorrect." }, 401);
  }
  return c.json({ ok: true });
});

// 4. Ajout d'un modèle
app.post("/products", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!c.env.ADMIN_PASSWORD || (body.password || "").trim() !== c.env.ADMIN_PASSWORD.trim()) {
    return c.json({ ok: false, error: "Non autorisé." }, 401);
  }
  if (!c.env.DATABASE_URL) {
    return c.json({ ok: false, error: "DATABASE_URL non configurée sur Cloudflare." }, 503);
  }
  try {
    const sql = neon(c.env.DATABASE_URL);
    await ensureTables(sql);
    const [row] = await sql`
      INSERT INTO custom_products (name, category, format, price_m2, stock_m2, image_url, seo_description)
      VALUES (
        ${body.name},
        ${body.category},
        ${body.format},
        ${Number(body.price_m2)},
        ${Number(body.stock_m2)},
        ${body.image_url || ""},
        ${body.seo_description || ""}
      )
      RETURNING *
    `;
    return c.json({ ok: true, product: row });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

// 5. Modification d'un modèle existant
app.put("/products/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!c.env.ADMIN_PASSWORD || (body.password || "").trim() !== c.env.ADMIN_PASSWORD.trim()) {
    return c.json({ ok: false, error: "Non autorisé." }, 401);
  }
  if (!c.env.DATABASE_URL) {
    return c.json({ ok: false, error: "DATABASE_URL non configurée sur Cloudflare." }, 503);
  }
  try {
    const sql = neon(c.env.DATABASE_URL);
    await ensureTables(sql);
    const id = Number(c.req.param("id"));
    const [row] = await sql`
      UPDATE custom_products
      SET
        name = ${body.name},
        category = ${body.category},
        format = ${body.format},
        price_m2 = ${Number(body.price_m2)},
        stock_m2 = ${Number(body.stock_m2)},
        image_url = ${body.image_url || ""},
        seo_description = ${body.seo_description || ""}
      WHERE id = ${id}
      RETURNING *
    `;
    return c.json({ ok: true, product: row });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

// 6. Suppression d'un modèle
app.delete("/products/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!c.env.ADMIN_PASSWORD || (body.password || "").trim() !== c.env.ADMIN_PASSWORD.trim()) {
    return c.json({ ok: false, error: "Non autorisé." }, 401);
  }
  if (!c.env.DATABASE_URL) {
    return c.json({ ok: false, error: "DATABASE_URL non configurée sur Cloudflare." }, 503);
  }
  try {
    const sql = neon(c.env.DATABASE_URL);
    await ensureTables(sql);
    await sql`DELETE FROM custom_products WHERE id = ${Number(c.req.param("id"))}`;
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

// 7. Demande de devis pose TVA 10%
app.post("/quotes", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!c.env.DATABASE_URL) {
    return c.json({ ok: true, localOnly: true });
  }
  try {
    const sql = neon(c.env.DATABASE_URL);
    await ensureTables(sql);
    await sql`
      INSERT INTO quote_requests (client_name, phone, city, surface_m2, details)
      VALUES (${body.client_name}, ${body.phone}, ${body.city}, ${Number(body.surface_m2 || 0)}, ${body.details || ""})
    `;
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

// 8. Paiement Stripe Checkout
app.post("/checkout", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ ok: false, error: "Variable STRIPE_SECRET_KEY manquante sur Cloudflare." }, 503);
  }
  const body = await c.req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    return c.json({ ok: false, error: "Votre panier est vide." }, 400);
  }

  const origin = new URL(c.req.url).origin;
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", `${origin}/?commande=validee`);
  params.append("cancel_url", `${origin}/?commande=annulee`);
