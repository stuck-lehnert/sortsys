import { uiText } from "~/lib/i18n";
import { useOutletContext } from "react-router";
import { from } from "rxjs";
import { AttrList } from "~/components/AttrList";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyDivider } from "~/components/MyDivider";
import { MyExpandable } from "~/components/MyExpandable";
import { MyLink } from "~/components/MyLink";
import { Remarks } from "~/components/Remarks";
import { TrackingTable } from "~/components/TrackingTable";
import { EntityActivityTimeline } from "~/components/EntityActivityTimeline";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useTitle } from "~/hooks/useTitle";
import { contactName, customerName, formatAddress, formatDate, userFullName } from "~/lib/format";
import { client } from "~/lib/client";
import { Icons } from "~/lib/icons";
import { renderStructuredPdf, type PdfCardSection, type PdfTableSection } from "~/lib/pdf";
import { ContactTile } from "~/lib/tiles";
import { addressUrl, deliverBlob } from "~/lib/utils";
import type { Project } from "~/type-helpers";
import { useMemo, useState } from "react";

function safeFilePart(value: string) {
  return value.replace(/[^\w\-]+/g, '-') || uiText('Projekt');
}

function contactPhoneLines(contact: { phoneNumbers: { name?: string | null; number: string }[] }) {
  const value = contact.phoneNumbers
    .map(({ name, number }) => name ? `${name}: ${number}` : number)
    .join('\n')
    .trim();
  return value || null;
}

function contactEmailLines(contact: { emailAddresses: { name?: string | null; email: string }[] }) {
  const value = contact.emailAddresses
    .map(({ name, email }) => name ? `${name}: ${email}` : email)
    .join('\n')
    .trim();
  return value || null;
}

function contactAddressLine(contact: { address?: Parameters<typeof formatAddress>[0] }) {
  return formatAddress(contact.address) || null;
}

function contactCardItems(contact: { address?: Parameters<typeof formatAddress>[0]; phoneNumbers: { name?: string | null; number: string }[]; emailAddresses: { name?: string | null; email: string }[] }) {
  const address = contactAddressLine(contact);
  const phone = contactPhoneLines(contact);
  const email = contactEmailLines(contact);

  return [
    address ? { label: uiText("Anschrift"), value: address } : null,
    phone ? { label: uiText("Telefon"), value: phone } : null,
    email ? { label: uiText("E-Mail"), value: email } : null,
  ].filter(Boolean) as { label: string; value: string }[];
}

export default function ProjectDetailPage() {
  const { project } = useOutletContext<{ project: Project }>();

  const sessionInfo = useSessionInfo();
  const canViewUsers = sessionInfo.canDo('view:users');
  const canViewContacts = sessionInfo.canDo('view:contacts');
  const [isContactSheetPrinting, setIsContactSheetPrinting] = useState(false);
  const [contactSheetPrintErr, setContactSheetPrintErr] = useState<string | null>(null);

  const [customer, customerError] = useClientStream(() => {
    if (!project.customerId) {
      return from([[null, null] as [null, null]]);
    }

    return client.streamQuery('customers.get', { id: project.customerId });
  }, [project.customerId]);
  const [responsibleProjectLeader, responsibleProjectLeaderError] = useClientStream(
    () => {
      if (!project.responsibleProjectLeaderUserId || !canViewUsers) {
        return from([[null, null] as [null, null]]);
      }

      return client.streamQuery('users.get', { id: project.responsibleProjectLeaderUserId });
    },
    [project.responsibleProjectLeaderUserId, canViewUsers],
  );
  const [contacts, contactsError] = useClientStream(() => client.streamQuery('projects.contacts.list', { projectId: project.id! }), [project.id]);
  const [trackings, trackingsError] = useClientStream(() => client.streamQuery('tools.trackings.list', { projectId: project.id!, finished: false }), [project.id]);

  useTitle(() => project ? uiText(`Übersicht – ${project.title}`, `Overview – ${project.title}`) : null, [JSON.stringify(project)]);

  const sortedTrackings = useMemo(() => {
    if (!trackings) return null;
    return trackings.slice().sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }, [trackings]);

  const hasProjectMeta = !!project.address || !!customer || !!project.responsibleProjectLeaderUserId || !!project.orderReceivedAt;

  async function downloadProjectContactSheet() {
    setContactSheetPrintErr(null);
    setIsContactSheetPrinting(true);

    try {
      const [freshContacts, contactsErr] = await client.query('projects.contacts.list', { projectId: project.id }, { strategy: 'network-first' });
      if (contactsErr) throw contactsErr;

      const [projectRemarks, projectRemarksErr] = await client.query('remarks.list', { resourceType: 'project', resourceId: project.id }, { strategy: 'network-first' });
      if (projectRemarksErr) throw projectRemarksErr;

      const [currentCustomer] = project.customerId
        ? await client.query('customers.get', { id: project.customerId }, { strategy: 'cache-first' })
        : [null, null] as const;

      const projectRows: string[][] = [
        [uiText('Projekt'), project.title],
        ['Anschrift', formatAddress(project.address) || '-'],
      ];
      if (project.orderReceivedAt) projectRows.push(['Auftrag erhalten am', formatDate(project.orderReceivedAt, 'long')]);
      if (project.customerId || currentCustomer) {
        projectRows.push([uiText('Kunde'), currentCustomer ? customerName(currentCustomer) : 'Unbekannt']);
        projectRows.push(['Kundenanschrift', currentCustomer?.address ? formatAddress(currentCustomer.address) : '-']);
        const customerPhone = currentCustomer ? contactPhoneLines(currentCustomer) : null;
        const customerEmail = currentCustomer ? contactEmailLines(currentCustomer) : null;
        if (customerPhone) projectRows.push(['Kunden-Telefon', customerPhone]);
        if (customerEmail) projectRows.push(['Kunden-E-Mail', customerEmail]);
      }
      if (project.responsibleProjectLeaderUserId) {
        if (canViewUsers) {
          const [user] = await client.query('users.get', { id: project.responsibleProjectLeaderUserId }, { strategy: 'cache-first' });
          projectRows.push([uiText('Verantwortlicher Projektleiter'), user ? userFullName(user) : 'Unbekannt']);
        } else {
          projectRows.push([uiText('Verantwortlicher Projektleiter'), uiText('Keine Berechtigung')]);
        }
      }

      const sortedContacts = [...(freshContacts ?? [])].sort((left, right) => {
        return contactName(left).localeCompare(contactName(right), 'de', { sensitivity: 'base' });
      });

      const sections: PdfTableSection[] = [
        {
          title: uiText("Projektdaten"),
          columns: ['Feld', uiText('Wert')],
          rows: projectRows,
          withHeader: false,
          align: ['left', 'left'],
          columnWidths: ['1fr', '2fr'],
        },
      ];
      const cardSections: PdfCardSection[] = [];

      const remarkRows = [...(projectRemarks ?? [])]
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .map((remark) => [formatDate(remark.createdAt, 'long'), remark.body]);
      if (remarkRows.length) {
        sections.push({
          title: uiText("Vermerke"),
          subtitle: uiText(`${remarkRows.length} ${remarkRows.length === 1 ? "Vermerk" : "Vermerke"} zum Projekt`, `${remarkRows.length} ${remarkRows.length === 1 ? "note" : "notes"} for the project`),
          columns: [uiText('Datum'), 'Vermerk'],
          rows: remarkRows,
          align: ['left', 'left'],
          columnWidths: ['0.8fr', '2.2fr'],
        });
      }

      if (sortedContacts.length) {
        cardSections.push({
          title: uiText("Ansprechpartner"),
          subtitle: uiText(`${sortedContacts.length} ${sortedContacts.length === 1 ? "Kontakt" : "Kontakte"} für dieses Projekt`, `${sortedContacts.length} ${sortedContacts.length === 1 ? "contact" : "contacts"} for this project`),
          cards: sortedContacts.map(contact => ({
            title: contactName(contact),
            badge: contact.label ?? 'Ansprechpartner',
            items: contactCardItems(contact),
          })),
        });
      } else {
        sections.push({
          title: uiText("Ansprechpartner"),
          columns: ['Hinweis'],
          rows: [[uiText('Keine Ansprechpartner hinterlegt.')]],
          withHeader: false,
          align: ['left'],
          columnWidths: ['1fr'],
        });
      }

      const pdfData = await renderStructuredPdf({
        title: project.title,
        reportLabel: uiText("Datenblatt"),
        sections,
        cardSections,
        emptyMessage: uiText("Keine Projektdaten verfügbar."),
      });

      const blob = new Blob([pdfData] as any, { type: 'application/pdf' });
      deliverBlob(blob, `Datenblatt-${safeFilePart(project.title)}.pdf`);
    } catch (err) {
      setContactSheetPrintErr((err as Error)?.message || uiText('Unbekannter Fehler beim Erstellen des Datenblatts.'));
    } finally {
      setIsContactSheetPrinting(false);
    }
  }

  return <>
    {canViewContacts && <div className="flex justify-end gap-2">
      <MyButton
        kind="ghost"
        size="sm"
        renderIcon={Icons.Download}
        loading={isContactSheetPrinting}
        disabled={isContactSheetPrinting}
        onClick={() => void downloadProjectContactSheet()}
      >{uiText("Datenblatt")}</MyButton>
    </div>}

    {!!contactSheetPrintErr && <MyCallout icon={Icons.Deny} color="red">{uiText("Datenblatt konnte nicht erstellt werden:")} {contactSheetPrintErr}
    </MyCallout>}

    {!!(customerError || responsibleProjectLeaderError || contactsError) && <MyCallout
      kind="error"
      title={uiText("Verknüpfte Projektdaten konnten nicht geladen werden", "Related project data could not be loaded")}
    />}

    {hasProjectMeta && <>
      <AttrList>
        {!!project.address && <AttrList.Attr name={uiText("Anschrift", "Address")} value={<MyLink target="_blank" to={addressUrl(project.address)}>{formatAddress(project.address)}</MyLink>} />}
        {!!customer && <AttrList.Attr name={uiText("Kunde")} value={<MyLink to={`/customers/${customer.id}`}>{customerName(customer)}</MyLink>} />}
        {!!project.orderReceivedAt && <AttrList.Attr name={uiText("Auftrag erhalten am", "Order received on")} value={formatDate(project.orderReceivedAt, 'long')} />}
        {!!project.responsibleProjectLeaderUserId && <AttrList.Attr
          name={uiText("Verantwortlicher Projektleiter")}
          value={
            !!responsibleProjectLeader
              ? <MyLink to={`/users/${responsibleProjectLeader.id}`}>{userFullName(responsibleProjectLeader)}</MyLink>
              : (canViewUsers ? 'Unbekannt' : uiText('Keine Berechtigung'))
          }
        />}
      </AttrList>

      <MyDivider />
    </>}

    <Remarks resourceType="project" resourceId={project.id} canManage={sessionInfo.canDo('manage:projects')} />

    <EntityActivityTimeline resourceType="project" resourceId={project.id} includeProjectContext />

    {!!contacts?.length && <MyExpandable title={uiText(`Ansprechpartner (${contacts.length})`, `Contacts (${contacts.length})`)}>
      <div className="space-y-2">
        {contacts.map((contact) => <ContactTile key={contact.id} contact={contact} />)}
      </div>
    </MyExpandable>}

    <MyExpandable title={uiText(`Gebuchte Werkzeuge (${sortedTrackings?.length ?? 0})`, `Booked tools (${sortedTrackings?.length ?? 0})`)}>
      <TrackingTable trackings={sortedTrackings ?? []} loading={!trackings} error={trackingsError} omit={['project']} />
    </MyExpandable>
  </>;
}
