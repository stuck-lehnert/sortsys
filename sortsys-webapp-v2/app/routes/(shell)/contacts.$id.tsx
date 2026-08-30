import { uiText } from "~/lib/i18n";
import { useParams } from "react-router";
import { Loading } from "@sortsys/react-components";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { NotFound } from "./_404";
import { MyHeader } from "~/components/MyHeader";
import { contactName, formatAddress } from "~/lib/format";
import { MyDivider } from "~/components/MyDivider";
import { MyExpandable } from "~/components/MyExpandable";
import { ContactTile, CustomerTile, ProjectTile } from "~/lib/tiles";
import { MyDropdown } from "~/components/MyDropdown";
import { Icons } from "~/lib/icons";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { AttrList } from "~/components/AttrList";
import { MyLink } from "~/components/MyLink";
import { useTitle } from "~/hooks/useTitle";
import { useShortcut } from "~/hooks/useShortcut";
import { showDeleteContactModal, showModifyContactModal } from "~/modals/contacts";
import { addressUrl } from "~/lib/utils";
import { Remarks } from "~/components/Remarks";
import { MyCallout } from "~/components/MyCallout";

export default function ContactDetailPage() {
  const { id } = useParams();

  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  
  const [contact, err] = useClientStream(() => client.streamQuery('contacts.get', { id: id! }), [id]);
  const [projects, projectsError] = useClientStream(() => client.streamQuery('contacts.projects.list', { contactId: id! }), [id]);
  const [customers, customersError] = useClientStream(() => client.streamQuery('contacts.customers.list', { contactId: id! }), [id]);

  useTitle(() => contact ? contactName(contact) : null, [contact]);

  useShortcut('Control+e', e => {
    if (!contact || !sessionInfo.canDo('manage:contacts')) return;
    e.preventDefault();
    showModifyContactModal(modals, contact);
  });

  if (err) return <NotFound reason="resourceNotFound" />;
  if (!contact) return <Loading withOverlay />;

  return <>
    <MyHeader
      title={contactName(contact)}
      actions={<>
        <MyDropdown items={[
          {
            label: uiText("Bearbeiten"),
            renderIcon: Icons.Edit,
            hideIf: !sessionInfo.canDo('manage:contacts'),
            onClick: () => showModifyContactModal(modals, contact),
          },
          {
            label: uiText("Löschen"),
            renderIcon: Icons.Delete,
            hideIf: !sessionInfo.canDo('delete:contacts'),
            onClick: () => showDeleteContactModal(modals, contact),
          }
        ]} />
      </>}
    />

    <AttrList>
      {!!contact.salutation && <AttrList.Attr name={uiText("Anrede", "Salutation")} value={contact.salutation} />}
      <AttrList.Attr name={uiText("Vorname", "First name")} value={contact.firstName} />
      {!!contact.lastName && <AttrList.Attr name={uiText("Nachname", "Last name")} value={contact.lastName} />}
      {!!contact.address && <AttrList.Attr name={uiText("Anschrift", "Address")} value={
        <MyLink to={addressUrl(contact.address)} target="_blank">{formatAddress(contact.address)}</MyLink>
      } />}
    </AttrList>

    <AttrList>
      {contact.emailAddresses.map(({ email, name }, i) => {
        return <AttrList.Attr key={i} name={name ?? uiText(`E-Mail ${i + 1}`, `Email ${i + 1}`)} value={<MyLink to={`mailto:${email}`}>{email}</MyLink>} />
      })}
      {contact.phoneNumbers.map(({ number, name }, i) => {
        return <AttrList.Attr key={i} name={name ?? uiText(`Telefon ${i + 1}`, `Phone ${i + 1}`)} value={<MyLink to={`tel:${number}`}>{number}</MyLink>} />
      })}
    </AttrList>

    <MyDivider />

    <Remarks resourceType="contact" resourceId={contact.id} canManage={sessionInfo.canDo('manage:contacts')} />
    {!!(projectsError || customersError) && <MyCallout
      kind="error"
      title={uiText("Verknüpfte Daten konnten nicht geladen werden", "Related data could not be loaded")}
    />}


    {!!customers?.length && <MyExpandable title={uiText(`Kunden (${customers.length})`, `Customers (${customers.length})`)}>
      <div className="space-y-2">
        {customers.map(customer => <CustomerTile key={customer.id} customer={customer} />)}
      </div>
    </MyExpandable>}

    {!!projects?.length && <MyExpandable title={uiText(`Projekte (${projects.length})`, `Projects (${projects.length})`)}>
      <div className="space-y-2">
        {projects.map(project => <ProjectTile key={project.id} project={project} />)}
      </div>
    </MyExpandable>}

  </>;
}
