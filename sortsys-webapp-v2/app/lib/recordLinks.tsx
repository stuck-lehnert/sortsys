import { MyLink } from "~/components/MyLink";
import { client } from "~/lib/client";
import { productTitle, userFullName } from "~/lib/format";
import type { Product } from "~/type-helpers";

const cacheFirst = { strategy: "cache-first" } as const;

export async function projectLink(id: string) {
  const [project] = await client.query("projects.get", { id }, cacheFirst);

  return project ? (
    <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>
  ) : "Unbekannt";
}

export async function memberLink(id: string | null | undefined) {
  if (!id) return "Unbekannt";

  const [user] = await client.query("users.get", { id }, cacheFirst);

  return user ? (
    <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>
  ) : "Unbekannt";
}

export async function productLink(
  id: string,
  title: (product: Product) => string = productTitle,
) {
  const [product] = await client.query("products.get", { id }, cacheFirst);

  return product ? (
    <MyLink to={`/products/${product.id}`}>{title(product)}</MyLink>
  ) : "Unbekannt";
}
