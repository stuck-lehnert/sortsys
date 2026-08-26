import { useParams } from "react-router";
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

export default function ContactDetailPage() {
  const { id } = useParams();

  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  
  const [contact, err] = useClientStream(() => client.streamQuery('contacts.get', { id: id! }), [id]);
  const [projects] = useClientStream(() => client.streamQuery('contacts.projects.list', { contactId: id! }), [id]);
  const [customers] = useClientStream(() => client.streamQuery('contacts.customers.list', { contactId: id! }), [id]);

  useTitle(() => contact ? contactName(contact) : null, [contact]);

  useShortcut('Control+e', e => {
    if (!contact || !sessionInfo.canDo('manage:contacts')) return;
    e.preventDefault();
    showModifyContactModal(modals, contact);
  });

  if (err) return <NotFound reason="resourceNotFound" />;
  if (!contact) return;

  return <>
    <MyHeader
      title={contactName(contact)}
      actions={<>
        <MyDropdown items={[
          {
            label: 'Bearbeiten',
            renderIcon: Icons.Edit,
            hideIf: !sessionInfo.canDo('manage:contacts'),
            onClick: () => showModifyContactModal(modals, contact),
          },
          {
            label: 'Löschen',
            renderIcon: Icons.Delete,
            hideIf: !sessionInfo.canDo('delete:contacts'),
            onClick: () => showDeleteContactModal(modals, contact),
          }
        ]} />
      </>}
    />

    <AttrList>
      {!!contact.salutation && <AttrList.Attr name="Anrede" value={contact.salutation} />}
      <AttrList.Attr name="Vorname" value={contact.firstName} />
      {!!contact.lastName && <AttrList.Attr name="Nachname" value={contact.lastName} />}
      {!!contact.address && <AttrList.Attr name="Anschrift" value={
        <MyLink to={addressUrl(contact.address)} target="_blank">{formatAddress(contact.address)}</MyLink>
      } />}
    </AttrList>

    <AttrList>
      {contact.emailAddresses.map(({ email, name }, i) => {
        return <AttrList.Attr key={i} name={name ?? `E-Mail ${i + 1}`} value={<MyLink to={`mailto:${email}`}>{email}</MyLink>} />
      })}
      {contact.phoneNumbers.map(({ number, name }, i) => {
        return <AttrList.Attr key={i} name={name ?? `Telefon ${i + 1}`} value={<MyLink to={`tel:${number}`}>{number}</MyLink>} />
      })}
    </AttrList>

    <MyDivider />

    <Remarks resourceType="contact" resourceId={contact.id} canManage={sessionInfo.canDo('manage:contacts')} />

    {!!customers?.length && <MyExpandable title={`Kunden (${customers.length})`}>
      <div className="space-y-2">
        {customers.map(customer => <CustomerTile key={customer.id} customer={customer} />)}
      </div>
    </MyExpandable>}

    {!!projects?.length && <MyExpandable title={`Projekte (${projects.length})`}>
      <div className="space-y-2">
        {projects.map(project => <ProjectTile key={project.id} project={project} />)}
      </div>
    </MyExpandable>}

  </>;
}
