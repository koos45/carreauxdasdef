import { Hono } from "hono";
import { handle } from "hono/cloudflare-pages";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import {
  customProducts,
  stockOverrides,
  hiddenProducts,
  customSupplies,
  quoteRequests,
  productPhotos,
} from "../db/schema.ts";

type Bindings = {
  DATABASE_URL: string;
  ADMIN_PASSWORD: string;
  STRIPE_SECRET_KEY: string;
  RESEND_API_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

function isAdmin(password: string | undefined, expected: string | undefined): boolean {
  if (!expected || !password) return false;
  const a = password.trim();
  const b = expected.trim();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const requireAdmin = async (c: any, next: () => Promise<void>) => {
  if (!c.env.ADMIN_PASSWORD) {
    return c.json({ error: "ADMIN_PASSWORD non configuré." }, 503);
  }
  if (!isAdmin(c.req.header("x-admin-password"), c.env.ADMIN_PASSWORD)) {
    return c.json({ error: "Mot de passe gérant incorrect." }, 401);
  }
  await next();
};

const str = (v: unknown, max = 300) => String(v ?? "").trim().slice(0, max);
const num = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function sanitizeProduct(p: any) {
  const images = Array.isArray(p?.images)
    ? p.images.map((u: unknown) => str(u, 600)).filter((u: string) => u.startsWith("/api/photos/") || u.startsWith("https://"))
    : [];
  return {
    id: str(p?.id, 80),
    name: str(p?.name, 120),
    category: str(p?.category, 60),
    format: str(p?.format, 60),
    discount: str(p?.discount, 10) || "-30%",
    oldPrice: num(p?.oldPrice, 0),
    priceSupply: num(p?.priceSupply, 0),
    pricePose: num(p?.pricePose, 0),
    boxSqm: num(p?.boxSqm, 1.44),
    norm: str(p?.norm, 120),
    inStock: p?.inStock !== false,
    images,
    desc: str(p?.desc, 2000),
  };
}

function sanitizeSupply(s: any) {
  const image = str(s?.image, 600);
  const domain = str(s?.domain || s?.desc, 2000);
  const specs = str(s?.specs, 2000);
  return {
    id: str(s?.id, 80),
    name: str(s?.name, 120),
    subtitle: str(s?.subtitle, 200),
    price: num(s?.price, 0),
    image: image.startsWith("/api/photos/") || image.startsWith("https://") ? image : "",
    domain,
    specs,
    desc: domain,
  };
}

app.get("/api/catalog", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const [rows, stock, hidden, suppliesRows] = await Promise.all([
    db.select().from(customProducts).orderBy(desc(customProducts.createdAt)),
    db.select().from(stockOverrides),
    db.select().from(hiddenProducts),
    db.select().from(customSupplies),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json({
    products: rows.map((r) => r.data),
    stock: Object.fromEntries(stock.map((s) => [s.productId, s.inStock])),
    hiddenIds: hidden.map((h) => h.productId),
    supplies: suppliesRows.map((s) => s.data),
  });
});

app.post("/api/quotes", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => null);
  const clientName = str(body?.clientName, 120) || "Non renseigné";
  const clientContact = str(body?.clientContact, 160);
  const clientCity = str(body?.clientCity, 120);
  const totalEstime = str(body?.totalEstime, 80) || "Sur devis";
  const detail = str(body?.detail, 4000);

  if (!clientContact || !detail) {
    return c.json({ error: "Contact et détail obligatoires." }, 400);
  }

  const id = `devis-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  await db.insert(quoteRequests).values({ id, clientName, clientContact, clientCity, totalEstime, detail });

  if (c.env.RESEND_API_KEY) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Carreaux Das <onboarding@resend.dev>",
        to: ["koos45120@gmail.com"],
        subject: `Nouveau devis Carreaux Das - ${clientName} (${totalEstime})`,
        text: `Nouvelle demande de devis :

Client : ${clientName}
Contact : ${clientContact}
Ville : ${clientCity || "Non renseignée"}
Total : ${totalEstime}

Détail :
${detail}`,
      }),
    }).catch((err) => console.error("Resend error:", err));
  }

  return c.json({ ok: true, id }, 201);
});

app.get("/api/admin/quotes", requireAdmin, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(quoteRequests).orderBy(desc(quoteRequests.createdAt));
  return c.json(rows);
});

app.delete("/api/admin/quotes/:id", requireAdmin, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  await db.delete(quoteRequests).where(eq(quoteRequests.id, str(c.req.param("id"), 80)));
  return c.json({ ok: true });
});

app.get("/api/photos/:key", async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const [photo] = await db.select().from(productPhotos).where(eq(productPhotos.key, c.req.param("key")));
  if (!photo) return c.text("Photo introuvable", 404);
  const binary = Uint8Array.from(atob(photo.base64Data), (ch) => ch.charCodeAt(0));
  return new Response(binary, {
    headers: {
      "Content-Type": photo.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

app.post("/api/admin/check", requireAdmin, (c) => c.json({ ok: true }));

app.post("/api/admin/photos", requireAdmin, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const { dataUrl } = await c.req.json().catch(() => ({}));
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) return c.json({ error: "Photo invalide." }, 400);
  const approxBytes = Math.floor((match[2].length * 3) / 4);
  if (approxBytes > MAX_PHOTO_BYTES) return c.json({ error: "Photo trop lourde." }, 413);
  const ext = match[1].split("/")[1].replace("jpeg", "jpg");
  const key = `${crypto.randomUUID()}.${ext}`;
  await db.insert(productPhotos).values({ key, contentType: match[1], base64Data: match[2] });
  return c.json({ url: `/api/photos/${key}` }, 201);
});

app.post("/api/admin/products", requireAdmin, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const product = sanitizeProduct(await c.req.json().catch(() => null));
  if (!product.id || !product.name) return c.json({ error: "Modèle incomplet." }, 400);
  if (product.images.length === 0) return c.json({ error: "Au moins une photo est requise." }, 400);
  await db
    .insert(customProducts)
    .values({ id: product.id, data: product })
    .onConflictDoUpdate({ target: customProducts.id, set: { data: product } });
  return c.json(product, 201);
});

app.delete("/api/admin/products/:id", requireAdmin, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = str(c.req.param("id"), 80);
  const [row] = await db.select().from(customProducts).where(eq(customProducts.id, id));
  await db.delete(customProducts).where(eq(customProducts.id, id));
  await db.delete(stockOverrides).where(eq(stockOverrides.productId, id));
  if (!id.startsWith("custom-")) {
    await db.insert(hiddenProducts).values({ productId: id }).onConflictDoNothing();
  }
  const images: string[] = (row?.data as any)?.images || [];
  await Promise.all(
    images
      .filter((u) => u.startsWith("/api/photos/"))
      .map((u) => db.delete(productPhotos).where(eq(productPhotos.key, u.slice("/api/photos/".length))))
  );
  return c.json({ ok: true });
});

app.put("/api/admin/stock/:id", requireAdmin, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const productId = str(c.req.param("id"), 80);
  const { inStock } = await c.req.json().catch(() => ({}));
  const value = Boolean(inStock);
  await db
    .insert(stockOverrides)
    .values({ productId, inStock: value })
    .onConflictDoUpdate({ target: stockOverrides.productId, set: { inStock: value, updatedAt: new Date() } });
  return c.json({ productId, inStock: value });
});

app.post("/api/admin/supplies", requireAdmin, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const supply = sanitizeSupply(await c.req.json().catch(() => null));
  if (!supply.id || !supply.name) return c.json({ error: "Fourniture incomplète." }, 400);
  await db
    .insert(customSupplies)
    .values({ id: supply.id, data: supply, updatedAt: new Date() })
    .onConflictDoUpdate({ target: customSupplies.id, set: { data: supply, updatedAt: new Date() } });
  return c.json(supply, 201);
});

app.delete("/api/admin/supplies/:id", requireAdmin, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = str(c.req.param("id"), 80);
  const [row] = await db.select().from(customSupplies).where(eq(customSupplies.id, id));
  await db.delete(customSupplies).where(eq(customSupplies.id, id));
  const image: string = (row?.data as any)?.image || "";
  if (image.startsWith("/api/photos/")) {
    await db.delete(productPhotos).where(eq(productPhotos.key, image.slice("/api/photos/".length)));
  }
  return c.json({ ok: true });
});

const handleCheckout = async (c: any) => {
  const stripeSecretKey = c.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    return c.json({ error: "Clé STRIPE_SECRET_KEY manquante." }, 500);
  }
  try {
    const { items, customerContact, delivery, successUrl, cancelUrl } = await c.req.json().catch(() => ({}));
    if (!Array.isArray(items) || items.length === 0) return c.json({ error: "Panier vide." }, 400);

    const clean = (v: unknown, max = 200) => String(v || "").trim().slice(0, max);
    const d = delivery && typeof delivery === "object" ? {
      firstName: clean(delivery.firstName, 80),
      lastName: clean(delivery.lastName, 80),
      email: clean(delivery.email, 200),
      phone: clean(delivery.phone, 30),
      address: clean(delivery.address),
      address2: clean(delivery.address2),
      zip: clean(delivery.zip, 10),
      city: clean(delivery.city, 100),
      notes: clean(delivery.notes, 450),
    } : null;

    const deliveryComplete = d && d.firstName && d.lastName && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)
      && d.phone && d.address && /^[0-9]{5}$/.test(d.zip) && d.city;

    if (!deliveryComplete) return c.json({ error: "Informations de livraison incomplètes." }, 400);

    const fullName = `${d.firstName} ${d.lastName}`;
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", successUrl || "https://www.carreauxdas.net/?payment=success");
    params.append("cancel_url", cancelUrl || "https://www.carreauxdas.net/?payment=cancel");
    params.append("locale", "fr");
    params.append("billing_address_collection", "auto");
    params.append("customer_email", d.email);
    params.append("payment_intent_data[shipping][name]", fullName);
    params.append("payment_intent_data[shipping][phone]", d.phone);
    params.append("payment_intent_data[shipping][address][line1]", d.address);
    if (d.address2) params.append("payment_intent_data[shipping][address][line2]", d.address2);
    params.append("payment_intent_data[shipping][address][postal_code]", d.zip);
    params.append("payment_intent_data[shipping][address][city]", d.city);
    params.append("payment_intent_data[shipping][address][country]", "FR");

    const meta: Record<string, string> = {
      livraison_nom: fullName,
      livraison_email: d.email,
      livraison_telephone: d.phone,
      livraison_adresse: [d.address, d.address2].filter(Boolean).join(", "),
      livraison_code_postal: d.zip,
      livraison_ville: d.city,
    };
    if (d.notes) meta.livraison_instructions = d.notes;
    Object.entries(meta).forEach(([k, v]) => {
      params.append(`metadata[${k}]`, v);
      params.append(`payment_intent_data[metadata][${k}]`, v);
    });
    if (customerContact && customerContact !== d.email) {
      params.append("metadata[contact_client]", clean(customerContact));
    }

    items.forEach((item: any, index: number) => {
      const amountInCents = Math.round(Number(item.price || 0) * 100);
      if (amountInCents > 0) {
        params.append(`line_items[${index}][price_data][currency]`, "eur");
        params.append(`line_items[${index}][price_data][product_data][name]`, String(item.title || "Carrelage Carreaux Das"));
        if (item.detail) params.append(`line_items[${index}][price_data][product_data][description]`, String(item.detail));
        params.append(`line_items[${index}][price_data][unit_amount]`, String(amountInCents));
        params.append(`line_items[${index}][quantity]`, "1");
      }
    });

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const session: any = await stripeRes.json();
    if (!stripeRes.ok) return c.json({ error: session.error?.message || "Erreur Stripe" }, stripeRes.status);
    return c.json({ url: session.url }, 200);
  } catch (err: any) {
    return c.json({ error: err.message || "Erreur serveur interne" }, 500);
  }
};

app.post("/api/create-checkout", handleCheckout);
app.post("/.netlify/functions/create-checkout", handleCheckout);

export const onRequest = handle(app);
