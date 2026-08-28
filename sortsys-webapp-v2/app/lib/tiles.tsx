import { uiText } from "~/lib/i18n";
import { Heading, Tag, Tile } from "@sortsys/react-components";
import { AttrList } from "~/components/AttrList";
import { Awaited } from "~/components/Awaited";
import { MyLink } from "~/components/MyLink";
import { client } from "~/lib/client";
import { contactName, customerName, formatAddress, formatCurrency, formatDate, productTitle, toolStatus, toolStatusTagType, toolTitle, userContractName, userFullName } from "~/lib/format";
import { nowrap } from "~/lib/primitives";
import { addressUrl } from "~/lib/utils";
import { dayInIsoWeek, isoWeekLabel, startOfIsoWeek, WEEKDAY_NAMES } from "~/lib/week";
import { type DeliveryNote, type Contact, type Customer, type Product, type ProductPriceRecord, type Project, type Tool, type ToolTracking, type User, type ProductVendor, type RegieReport, type DailyProjectReport } from "~/type-helpers";
import { Icons, type Icon } from "./icons";
import type { ComponentProps, ReactNode } from "react";

export function SmallTile({ icon: Icon, title, href, subtitle, onLinkClick }: {
  icon?: Icon; title: ReactNode; href?: string; subtitle?: ReactNode; onLinkClick?: () => void
}) {
  return <Tile className="w-full max-w-full">
    <div className="w-full max-w-full flex gap-2 items-center">
      {!!Icon && <Icon size={20} className="shrink-0" />}

      <div className="grow max-w-full overflow-hidden">
        {!!href ? <Heading level={5} noMargin>
          <MyLink className={nowrap({ class: 'max-w-full' })} to={href} onClick={onLinkClick}>{title}</MyLink>
        </Heading> : <Heading level={5} noMargin className={nowrap({ class: 'max-w-full' })}>
          <span>{title}</span>
        </Heading>}

        {!!subtitle && subtitle}
      </div>
    </div>
  </Tile>
}

function createSmallTile<T>(build: (data: T) => ComponentProps<typeof SmallTile>) {
  return function({ data, noLink, noIcon, onLinkClick }: { data: T; noLink?: boolean; noIcon?: boolean; onLinkClick?: () => void }) {
    const built = build(data);
    return <SmallTile {...built}
      onLinkClick={onLinkClick}
      href={noLink ? undefined : built.href}
      icon={noIcon ? undefined : built.icon}
    />;
  }
}

export const SmallProjectTile = createSmallTile<Project>(project => ({
  icon: Icons.Project,
  title: project.title,
  href: `/projects/${project.id}`,
}));

export const SmallToolTile = createSmallTile<Tool>(tool => ({
  icon: Icons.Tool,
  title: `${tool.customId} ${toolTitle(tool)}`,
  subtitle: <Tag size="sm" type={toolStatusTagType(tool)}>{toolStatus(tool)}</Tag>,
  href: `/tools/${tool.id}`,
}));

export const SmallUserTile = createSmallTile<User>(user => ({
  icon: Icons.User,
  title: userFullName(user),
  href: `/users/${user.id}`,
}));

export const SmallContactTile = createSmallTile<Contact>(contact => ({
  icon: Icons.Contact,
  title: contactName(contact),
  href: `/contacts/${contact.id}`,
}));

export const SmallProductTile = createSmallTile<Product>(product => ({
  icon: Icons.Product,
  title: `${product.customId} ${productTitle(product)}`,
  href: `/products/${product.id}`,
}));

export const SmallCustomerTile = createSmallTile<Customer>(customer => ({
  icon: Icons.Customer,
  title: customerName(customer),
  href: `/customers/${customer.id}`,
}));

export const SmallDeliveryNoteTile = createSmallTile<DeliveryNote>(note => ({
  icon: Icons.DeliveryNote,
  title: uiText(`Lieferschein #${note.autoId}`, `Delivery note #${note.autoId}`),
  href: `/products/deliveryNotes/${note.id}`,
  subtitle: formatDate(note.createdAt),
}));

export const SmallProductVendorTile = createSmallTile<ProductVendor>(vendor => ({
  icon: Icons.ProductVendor,
  title: vendor.name,
  href: `/products/vendors/${vendor.id}`,
}));

export const SmallRegieReportTile = createSmallTile<RegieReport>(report => ({
  icon: Icons.RegieReport,
  title: uiText(`Regiebericht #${report.autoId}`, `Time-and-material report #${report.autoId}`),
  href: `/regieReports/${report.id}`,
}));

export const dailyReportDayKey = (day: Date) => {
  const year = day.getFullYear();
  const month = `${day.getMonth() + 1}`.padStart(2, '0');
  const date = `${day.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${date}`;
};

export const SmallDailyProjectReportTile = createSmallTile<DailyProjectReport>(report => ({
  icon: Icons.DailyReport,
  title: uiText(`Bautagesbericht ${formatDate(report.day)}`, `Daily report ${formatDate(report.day)}`),
  href: `/projects/${report.projectId}/dailyReports/${dailyReportDayKey(report.day)}`,
}));

export function DailyProjectReportTile({ report }: { report: DailyProjectReport }) {
  const dayKey = dailyReportDayKey(report.day);

  return <Tile key={report.id} className="w-full">
    <Heading level={5} noMargin>
      <MyLink className={nowrap({ class: 'max-w-full' })} to={`/projects/${report.projectId}/dailyReports/${dayKey}`}>
        {uiText("Bautagesbericht", "Daily construction report")} {formatDate(report.day)}
      </MyLink>
    </Heading>

    <AttrList>
      <AttrList.Attr name={uiText("Beschreibung")} value={report.summary} />
      <AttrList.Attr name={uiText("Arbeitszeit")} value={uiText(`${report.workHours.length} Einträge`, `${report.workHours.length} entries`)} />
    </AttrList>
  </Tile>;
}

export function RegieReportTile({ report, omit }: { report: RegieReport; omit?: ('project')[] }) {
  omit ??= [];

  const weekStart = startOfIsoWeek(new Date(report.day));
  const weekEnd = dayInIsoWeek(weekStart, WEEKDAY_NAMES.length - 1);

  return <Tile key={report.id} className="w-full">
    <Heading level={5} noMargin>
      <MyLink className={nowrap({ class: 'max-w-full' })} to={`/regieReports/${report.id}`}>
        {uiText("Regiebericht", "Time-and-material report")} #{report.autoId}
      </MyLink>
    </Heading>

    <AttrList>
      {!omit.includes('project') && <AttrList.Attr name={uiText("Projekt")} value={<Awaited promise={async () => {
        const [project] = await client.query('projects.get', { id: report.projectId }, { strategy: 'cache-first' });
        if (!project) return 'Unbekannt';
        return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
      }} />} />}

      <AttrList.Attr name="Kalenderwoche" value={isoWeekLabel(weekStart)} />
      <AttrList.Attr name={uiText("Zeitraum")} value={uiText(`${formatDate(weekStart)} bis ${formatDate(weekEnd)}`, `${formatDate(weekStart)} to ${formatDate(weekEnd)}`)} />
      {!!report.summary && <AttrList.Attr name="Zusammenfassung" value={report.summary} />}
      <AttrList.Attr name={uiText("Arbeitszeit")} value={uiText(`${report.workHours.length} Einträge`, `${report.workHours.length} entries`)} />
      <AttrList.Attr name={uiText("Produkte")} value={uiText(`${report.products.length} Einträge`, `${report.products.length} entries`)} />
    </AttrList>
  </Tile>;
}

export function ProjectTile({ project, omit }: {
  project: Project;
  omit?: ('address' | 'customer')[];
}) {
  omit ??= [];

  return <Tile key={project.id} className="w-full">
    <Heading level={5} noMargin>
      <MyLink className={nowrap({ class: 'max-w-full' })} to={`/projects/${project.id}`}>{project.title}</MyLink>
    </Heading>

    <AttrList>
      {!!project.address && !omit.includes('address') && <AttrList.Attr name="Anschrift" value={
        <MyLink to={addressUrl(project.address)} target="_blank">{formatAddress(project.address)}</MyLink>
      } />}

      {!!project.customerId && !omit.includes('customer') && <AttrList.Attr name={uiText("Kunde")} value={<Awaited promise={async () => {
        const [customer] = await client.query('customers.get', { id: project.customerId! }, { strategy: 'cache-first' });
        if (!customer) return 'Unbekannt';
        return <MyLink to={`/customers/${customer.id}`}>{customerName(customer)}</MyLink>;
      }} />} />}
    </AttrList>
  </Tile>;
}

export function ToolTile({ tool }: {
  tool: Tool;
}) {
  return <Tile key={tool.id} className="w-full">
    <Heading level={5} noMargin>
      <MyLink className={nowrap({ class: 'max-w-full' })} to={`/tools/${tool.id}`}>{tool.customId} {toolTitle(tool)}</MyLink>
    </Heading>

    <Tag type={toolStatusTagType(tool)}>{toolStatus(tool)}</Tag>
  </Tile>;
}

export function UserTile({ user }: {
  user: User;
}) {
  return <Tile key={user.id} className="w-full">
    <Heading level={5} noMargin>
      <MyLink className={nowrap({ class: 'max-w-full' })} to={`/users/${user.id}`}>{userFullName(user)}</MyLink>
    </Heading>

    <AttrList>
      <AttrList.Attr name="Vertrag" value={userContractName(user)} />

      {!!user.email && <AttrList.Attr name="E-Mail" value={<MyLink to={`mailto:${user.email}`}>{user.email}</MyLink>} />}
      {!!user.phone && <AttrList.Attr name="Telefon" value={<MyLink to={`tel:${user.phone}`}>{user.phone}</MyLink>} />}
    </AttrList>
  </Tile>;
}

export function ProductTile({ product }: {
  product: Product;
}) {
  return <Tile key={product.id} className="w-full">
    <Heading level={5} noMargin>
      <MyLink className={nowrap({ class: 'max-w-full' })} to={`/products/${product.id}`}>
        {product.customId} {productTitle(product)}
      </MyLink>
    </Heading>


    <AttrList>
      {!!product.description && <AttrList.Attr name={uiText("Beschreibung")} value={product.description} />}
    </AttrList>
  </Tile>
}

export function CustomerTile({ customer, omit }: {
  customer: Customer;
  omit?: ('address')[];
}) {
  omit ??= [];

  return <Tile key={customer.id} className="w-full">
    <Heading level={5} noMargin>
      <MyLink className={nowrap({ class: 'max-w-full' })} to={`/customers/${customer.id}`}>{customerName(customer)}</MyLink>
    </Heading>

    <AttrList>
      {!!customer.address && !omit.includes('address') && <AttrList.Attr name="Anschrift" value={
        <MyLink to={addressUrl(customer.address)} target="_blank">{formatAddress(customer.address)}</MyLink>
      } />}
      {customer.emailAddresses.map(({ email, name }, i) => {
        return <AttrList.Attr key={i} name={name ?? `E-Mail ${i + 1}`} value={<MyLink to={`mailto:${email}`}>{email}</MyLink>} />
      })}
      {customer.phoneNumbers.map(({ number, name }, i) => {
        return <AttrList.Attr key={i} name={name ?? `Telefon ${i + 1}`} value={<MyLink to={`tel:${number}`}>{number}</MyLink>} />
      })}
    </AttrList>
  </Tile>;
}

export function ContactTile({ contact }: {
  contact: Contact & { label?: string | null };
}) {
  return <Tile key={contact.id} className="w-full">
    <Heading level={5} noMargin>
      <MyLink className={nowrap({ class: 'max-w-full' })} to={`/contacts/${contact.id}`}>{contactName(contact)}</MyLink>
    </Heading>

    <AttrList>
      {!!contact.label && <AttrList.Attr name="Rolle" value={contact.label} />}
      {!!contact.address && <AttrList.Attr name="Anschrift" value={
        <MyLink to={addressUrl(contact.address)} target="_blank">{formatAddress(contact.address)}</MyLink>
      } />}
      {contact.emailAddresses.map(({ email, name }, i) => {
        return <AttrList.Attr key={i} name={name ?? `E-Mail ${i + 1}`} value={<MyLink to={`mailto:${email}`}>{email}</MyLink>} />
      })}
      {contact.phoneNumbers.map(({ number, name }, i) => {
        return <AttrList.Attr key={i} name={name ?? `Telefon ${i + 1}`} value={<MyLink to={`tel:${number}`}>{number}</MyLink>} />
      })}
    </AttrList>
  </Tile>;
}

export function TrackingTile({ tracking, omit }: {
  tracking: ToolTracking;
  omit?: ("tool" | "project" | "author" | "responsible" | "timestamps")[];
}) {
  omit ??= [];

  return <Tile key={tracking.id} className="w-full">
    <AttrList>
      {!omit.includes('tool') && <AttrList.Attr name={uiText("Werkzeug")} value={<Awaited promise={async () => {
        const [tool] = await client.query('tools.get', { id: tracking.toolId });
        if (!tool) return 'Unbekannt';
        return <MyLink to={`/tools/${tool.id}`}>{tool.customId} {toolTitle(tool)}</MyLink>;
      }} />} />}

      {!omit.includes('project') && !!tracking.projectId && <AttrList.Attr name={uiText("Projekt")} value={<Awaited promise={async () => {
        const [project] = await client.query('projects.get', { id: tracking.projectId! });
        if (!project) return 'Unbekannt';
        return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
      }} />} />}

      {!omit.includes('responsible') && !!tracking.responsibleUserId && <AttrList.Attr name="Verantwortlich" value={<Awaited promise={async () => {
        const [user] = await client.query('users.get', { id: tracking.responsibleUserId! });
        if (!user) return 'Unbekannt';
        return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
      }} />} />}

      {!omit.includes('author') && !!tracking.startedByUserId && <AttrList.Attr name="Herausgeber" value={<Awaited promise={async () => {
        const [user] = await client.query('users.get', { id: tracking.startedByUserId! });
        if (!user) return 'Unbekannt';
        return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
      }} />} />}

      {!omit.includes('timestamps') && <>
        <AttrList.Attr name={!!tracking.endedAt ? uiText('Von') : 'Seit'} value={formatDate(tracking.startedAt)} />
        {!!tracking.endedAt && <AttrList.Attr name={uiText('Bis')} value={formatDate(tracking.endedAt)} />}
        {!!tracking.deadlineAt && <AttrList.Attr name={'Deadline'} value={formatDate(tracking.deadlineAt)} />}
      </>}
    </AttrList>
  </Tile>;
}

export function ProductPriceRecordTile({ priceRecord, omit }: {
  priceRecord: ProductPriceRecord;
  omit?: ('product' | 'vendor')[];
}) {
  omit ??= [];

  return <Tile key={priceRecord.id} className="w-full">
    <AttrList>
      <AttrList.Attr name={uiText("Datum")} value={formatDate(priceRecord.timestamp)} />
      <AttrList.Attr name="Preis" value={<>
        {formatCurrency(priceRecord.price)} / <Awaited promise={async () => {
          const [product] = await client.query('products.get', { id: priceRecord.productId });
          if (!product) return '???';
          return product.baseUnit;
        }} />
      </>} />

      {!omit.includes('product') && <AttrList.Attr name="Produkt" value={<Awaited promise={async () => {
        const [product] = await client.query('products.get', { id: priceRecord.productId });
        if (!product) return 'Unbekannt';
        return <MyLink to={`/products/${product.id}`}>{product.customId} {productTitle(product)}</MyLink>;
      }} />} />}

      {!omit.includes('vendor') && !!priceRecord.vendorId && <AttrList.Attr name={uiText("Händler")} value={<Awaited promise={async () => {
        const [vendor] = await client.query('products.vendors.get', { id: priceRecord.vendorId! });
        if (!vendor) return 'Unbekannt';
        return <MyLink to={`/products/vendors/${vendor.id}`}>{vendor.name}</MyLink>;
      }} />} />}
    </AttrList>
  </Tile>;
}
