import { MyForm } from "~/components/MyForm";
import { client } from "~/lib/client";
import { SmallTile } from "~/lib/tiles";

const facetMethods = {
  products: {
    brand: "products.brands.list",
    category: "products.categories.list",
  },
  tools: { brand: "tools.brands", category: "tools.categories" },
} as const;

type InventoryFacetFieldProps = {
  catalog: keyof typeof facetMethods;
  name: "brand" | "category";
  labelText: string;
};

export function InventoryFacetField({
  catalog,
  name,
  labelText,
}: InventoryFacetFieldProps) {
  return (
    <MyForm.MultiSelect
      name={name}
      labelText={labelText}
      maxSelectedItems={1}
      prepare={async () => {
        const [values, error] = await client.query(
          facetMethods[catalog][name],
          undefined,
        );
        if (error) throw error;
        return values ?? [];
      }}
      getOptions={({ query, init }) => {
        const normalized = query.toLowerCase();
        return init
          .filter((value) => value.toLowerCase().includes(normalized))
          .map((id) => ({ id }));
      }}
      renderItem={({ item }) => item.id}
      renderTile={(item) => <SmallTile title={item.id} />}
    />
  );
}
