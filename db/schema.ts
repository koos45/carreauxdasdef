import { pgTable, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";

export const customProducts = pgTable("custom_products", {
  id: text().primaryKey(),
  data: jsonb().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const stockOverrides = pgTable("stock_overrides", {
  productId: text("product_id").primaryKey(),
  inStock: boolean("in_stock").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const hiddenProducts = pgTable("hidden_products", {
  productId: text("product_id").primaryKey(),
  hiddenAt: timestamp("hidden_at").defaultNow().notNull(),
});

export const customSupplies = pgTable("custom_supplies", {
  id: text().primaryKey(),
  data: jsonb().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const quoteRequests = pgTable("quote_requests", {
  id: text().primaryKey(),
  clientName: text("client_name").notNull(),
  clientContact: text("client_contact").notNull(),
  clientCity: text("client_city").notNull(),
  totalEstime: text("total_estime").notNull(),
  detail: text().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const productPhotos = pgTable("product_photos", {
  key: text().primaryKey(),
  contentType: text("content_type").notNull(),
  base64Data: text("base64_data").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
