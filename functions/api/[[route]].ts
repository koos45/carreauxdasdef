import { Hono } from "hono";
import { handle } from "hono/cloudflare-pages";
import { neon } from "@neondatabase/serverless";

type Bindings = {
  DATABASE_URL?: string;
  ADMIN_PASSWORD?: string;
  STRIPE_SECRET_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>().basePath("/api");

const SEED_PRODUCTS = [
  {
    name: "Pierre de Vals Anthracite",
    category: "Effet Pierre",
    format: "60x60 cm • Grès Cérame Rectifié R10",
    price_m2: 26.90,
    stock_m2: 145,
    image_url: "https://images.unsplash.com/photo-1615873968403-89e068629265?auto=format&fit=crop&w=750&q=80",
    seo_description: "Carrelage grès cérame effet pierre naturelle de Vals anthracite au format 60x60 cm rectifié. Bords coupés avec précision pour des joints fins de 2 mm. Résistant au gel, au passage intensif (PEI V) et antidérapant R10 : idéal pour salon, cuisine, entrée et salle de bain moderne. Compatible plancher chauffant."
  },
  {
    name: "Calacatta Gold Veiné",
    category: "Effet Marbre",
    format: "60x120 cm • Rectifié Satiné",
    price_m2: 32.50,
    stock_m2: 90,
    image_url: "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=750&q=80",
    seo_description: "Carrelage grand format 60x120 cm imitation marbre blanc Calacatta aux veinages dorés et gris subtils. Finition satinée lumineuse facile d'entretien, sans traitement hydrofuge contrairement au marbre naturel. Parfait pour sublimer un séjour contemporain, une douche à l'italienne ou un mur d'accent."
  },
  {
    name: "Chêne Naturel Miel",
    category: "Effet Bois",
    format: "20x120 cm • Imitation Parquet Rectifié",
    price_m2: 24.90,
    stock_m2: 180,
    image_url: "https://images.unsplash.com/photo-1581858726788-75bc0f6a952d?auto=format&fit=crop&w=750&q=80",
    seo_description: "Lame de carrelage imitation parquet chêne naturel miel 20x120 cm à veinage bois structuré authentique. Allie la chaleur visuelle d'un parquet massif à la robustesse du grès cérame : insensible à l'eau, aux rayures et compatible avec tous les systèmes de chauffage au sol."
  },
  {
    name: "Béton Ciré Gris Perle",
    category: "Effet Béton",
    format: "80x80 cm • Pleine Masse Rectifié",
    price_m2: 28.00,
    stock_m2: 110,
    image_url: "https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=750&q=80",
    seo_description: "Carrelage grand format 80x80 cm aspect béton ciré gris perle nuancé, conçu pour agrandir visuellement les espaces de vie ouverts. Grès cérame pleine masse rectifié haute densité, résistant aux taches et aux chocs, offrant un rendu minéral épuré sans fissures ni entretien contraignant."
  },
  {
    name: "Dalle Terrasse Ardoise 20mm",
    category: "Extérieur R11",
    format: "60x60x2 cm • Antidérapant R11",
    price_m2: 34.90,
    stock_m2: 120,
    image_url: "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=750&q=80",
    seo_description: "Dalle extérieure forte épaisseur 20 mm (60x60 cm) finition ardoise structurée antidérapante norme R11. Pose polyvalente sur plots réglables, sur gravier, sur pelouse ou collée sur dalle béton. Ingélive, résistante aux UV, au chlore et aux intempéries : idéale pour terrasses et plages de piscine."
  },
  {
    name: "Mortier-Colle Flex C2TE S1 (Sac 25 kg)",
    category: "Fournitures",
    format: "Sac 25 kg • Gris ou Blanc",
    price_m2: 18.50,
    stock_m2: 85,
    image_url: "https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=750&q=80",
    seo_description: "Mortier-colle déformable haute performance classé C2TE S1 en sac de 25 kg, spécialement formulé pour la pose de carrelages grand format (60x60, 80x80, 60x120 cm) en intérieur et extérieur, sols chauffants et supports exigeants. Temps ouvert allongé et adhérence renforcée conforme aux DTU."
  }
];

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
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;

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

  // Si la base n'a jamais été initialisée, on importe les 6 modèles une seule fois
  // Ainsi, si vous en supprimez un ensuite, il reste définitivement supprimé !
  const seeded = await sql`SELECT value FROM app_settings WHERE key = 'initial_seed_done'`;
  if (seeded.length === 0) {
    const existing = await sql`SELECT COUNT(*)::int AS count FROM custom_products`;
    if (existing[0].count === 0) {
      for (const p of SEED_PRODUCTS) {
        await sql`
          INSERT INTO custom_products (name, category, format, price_m2, stock_m2, image_url, seo_description)
          VALUES (${p.name}, ${p.category}, ${p.format}, ${p.price_m2}, ${p.stock_m2}, ${p.image_url}, ${p.seo_description})
        `;
      }
    }
    await sql`INSERT INTO app_settings (key, value) VALUES ('initial_seed_done', 'true') ON CONFLICT (key) DO NOTHING`;
  }
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

// 2. Liste complète des produits depuis Neon
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

// 6. Suppression d'un modèle (n'importe lequel)
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

  items.forEach((item: any, i: number) => {
    params.append(`line_items[${i}][price_data][currency]`, "eur");
    params.append(`line_items[${i}][price_data][product_data][name]`, item.name);
    params.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(Number(item.totalPrice) * 100)));
    params.append(`line_items[${i}][quantity]`, "1");
  });

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY.trim()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const session: any = await res.json();
  if (!res.ok) {
    return c.json({ ok: false, error: session?.error?.message || "Erreur Stripe" }, 400);
  }
  return c.json({ ok: true, url: session.url });
});

export const onRequest = handle(app);
