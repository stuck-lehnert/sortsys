import { useEffect, useState } from "react";
import { MyLink } from "~/components/MyLink";
import { client } from "~/lib/client";
import { uiText, useI18n, type Locale } from "~/lib/i18n";

export type ProposalEntityKind =
  | 'contact'
  | 'customer'
  | 'deliveryNote'
  | 'product'
  | 'project'
  | 'regieReport'
  | 'tool'
  | 'user'
  | 'vendor';

type ResolvedEntity = {
  href: string;
  label: string;
};

export function proposalEntityKind(
  field: string,
  operationPath: string,
  rootInput: Record<string, unknown>,
): ProposalEntityKind | null {
  const directReferences: Record<string, ProposalEntityKind> = {
    customerId: 'customer',
    productId: 'product',
    projectId: 'project',
    responsibleProjectLeaderUserId: 'user',
    userId: 'user',
    toolId: 'tool',
    vendorId: 'vendor',
  };

  if (directReferences[field]) return directReferences[field];

  if (field === 'resourceId') {
    const resourceType = rootInput.resourceType;

    return resourceType === 'contact'
      || resourceType === 'customer'
      || resourceType === 'project'
      || resourceType === 'tool'
      ? resourceType
      : null;
  }

  if (field !== 'id') return null;
  if (operationPath.startsWith('contacts.')) return 'contact';
  if (operationPath.startsWith('customers.')) return 'customer';
  if (operationPath.startsWith('deliveryNotes.')) return 'deliveryNote';
  if (operationPath.startsWith('products.priceRecords.')) return null;
  if (operationPath.startsWith('products.')) return 'product';
  if (operationPath.startsWith('projects.costs.')) return null;
  if (operationPath.startsWith('projects.deployments.')) return null;
  if (operationPath.startsWith('projects.')) return 'project';
  if (operationPath.startsWith('regieReports.')) return 'regieReport';
  if (operationPath.startsWith('tools.')) return 'tool';

  return null;
}

async function loadEntity(kind: ProposalEntityKind, id: string, locale: Locale): Promise<ResolvedEntity | null> {
  switch (kind) {
    case 'contact': {
      const [value, error] = await client.query('contacts.get', { id });
      if (error || !value) return null;

      const label = [value.firstName, value.lastName].filter(Boolean).join(' ').trim();
      return { href: `/contacts/${id}`, label: label || uiText("Kontakt") };
    }
    case 'customer': {
      const [value, error] = await client.query('customers.get', { id });
      return error || !value ? null : { href: `/customers/${id}`, label: value.name };
    }
    case 'deliveryNote': {
      const [value, error] = await client.query('deliveryNotes.get', { id });
      return error || !value
        ? null
        : { href: `/products/deliveryNotes/${id}`, label: locale === 'de' ? uiText(`Lieferschein ${value.autoId}`, `Delivery note ${value.autoId}`) : `Delivery note ${value.autoId}` };
    }
    case 'product': {
      const [value, error] = await client.query('products.get', { id });
      return error || !value ? null : { href: `/products/${id}`, label: value.name };
    }
    case 'project': {
      const [value, error] = await client.query('projects.get', { id });
      return error || !value ? null : { href: `/projects/${id}`, label: value.title };
    }
    case 'regieReport': {
      const [value, error] = await client.query('regieReports.get', { id });
      return error || !value
        ? null
        : { href: `/regieReports/${id}`, label: locale === 'de' ? uiText(`Regiebericht ${value.autoId}`, `Time-and-material report ${value.autoId}`) : `Time-and-material report ${value.autoId}` };
    }
    case 'tool': {
      const [value, error] = await client.query('tools.get', { id });
      if (error || !value) return null;

      const name = value.label || value.category;
      return { href: `/tools/${id}`, label: `${value.customId} · ${value.brand} · ${name}` };
    }
    case 'user': {
      const [value, error] = await client.query('users.get', { id });
      if (error || !value) return null;

      const label = [value.firstName, value.lastName].filter(Boolean).join(' ').trim();
      return { href: `/users/${id}`, label: label || value.username };
    }
    case 'vendor': {
      const [value, error] = await client.query('products.vendors.get', { id });
      return error || !value
        ? null
        : { href: `/products/vendors/${id}`, label: value.name };
    }
  }
}

export function ProposalEntityReference({
  id,
  kind,
}: {
  id: string;
  kind: ProposalEntityKind;
}) {
  const { locale, t } = useI18n();
  const [resolved, setResolved] = useState<ResolvedEntity | null | undefined>(undefined);

  useEffect(() => {
    let active = true;

    setResolved(undefined);
    void loadEntity(kind, id, locale).then(value => {
      if (active) setResolved(value);
    });

    return () => {
      active = false;
    };
  }, [id, kind, locale]);

  if (resolved === undefined) return <span>{t('common.loading')}</span>;
  if (resolved === null) return <span>{t('common.unavailable')}</span>;

  return <MyLink to={resolved.href}>{resolved.label}</MyLink>;
}
