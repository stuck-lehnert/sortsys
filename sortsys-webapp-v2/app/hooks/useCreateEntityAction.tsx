import type { MyMultiSelectCreateAction } from "~/components/MyForm";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { showCreateContactModal } from "~/modals/contacts";
import { showCreateCustomerModal } from "~/modals/customers";
import { showCreateProductModal } from "~/modals/products";
import { showCreateProductVendorModal } from "~/modals/productVendors";
import { showCreateProjectModal } from "~/modals/projects";
import { showCreateToolModal } from "~/modals/tools";
import { showCreateUserModal } from "~/modals/users";
import type { Contact, Customer, Product, ProductVendor, Project, Tool, User } from "~/type-helpers";

function createAction<T>(label: string, run: (query: string, select: (item: T) => void) => void): MyMultiSelectCreateAction<T> {
  return {
    label: ({ query }) => `${label}: ${query}`,
    onCreate: ({ query, select }) => run(query, select),
  };
}

export function useCreateEntityAction(modals: MyModalsInterface) {
  const sessionInfo = useSessionInfo();

  return {
    contact: sessionInfo.canDo('manage:contacts')
      ? createAction<Contact>('Kontakt erstellen', (query, select) => showCreateContactModal(modals, {
        initialQuery: query,
        onCreated: select,
      }))
      : undefined,

    customer: sessionInfo.canDo('manage:customers')
      ? createAction<Customer>('Kunde erstellen', (query, select) => showCreateCustomerModal(modals, {
        initialQuery: query,
        onCreated: select,
      }))
      : undefined,

    product: sessionInfo.canDo('manage:products')
      ? createAction<Product>('Produkt erstellen', (query, select) => showCreateProductModal(modals, {
        initialQuery: query,
        onCreated: select,
      }))
      : undefined,

    productVendor: sessionInfo.canDo('manage:productVendors')
      ? createAction<ProductVendor>('Händler erstellen', (query, select) => showCreateProductVendorModal(modals, {
        initialQuery: query,
        onCreated: select,
      }))
      : undefined,

    project: sessionInfo.canDo('manage:projects')
      ? createAction<Project>('Projekt erstellen', (query, select) => showCreateProjectModal(modals, {
        initialQuery: query,
        onCreated: select,
      }))
      : undefined,

    tool: sessionInfo.canDo('manage:tools')
      ? createAction<Tool>('Werkzeug erstellen', (query, select) => showCreateToolModal(modals, {
        initialQuery: query,
        onCreated: select,
      }))
      : undefined,

    user: sessionInfo.canDo('manage:users')
      ? createAction<User>('Benutzer erstellen', (query, select) => showCreateUserModal(modals, {
        initialQuery: query,
        onCreated: select,
      }))
      : undefined,
  };
}
