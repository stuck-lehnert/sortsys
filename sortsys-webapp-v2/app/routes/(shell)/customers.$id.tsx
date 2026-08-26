import { useParams } from "react-router";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { NotFound } from "./_404";
import { MyHeader } from "~/components/MyHeader";
import { customerName, formatAddress } from "~/lib/format";
import { MyDropdown } from "~/components/MyDropdown";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { Icons } from "~/lib/icons";
import { showDeleteCustomerModal, showModifyCustomerModal } from "~/modals/customers";
import { MyDivider } from "~/components/MyDivider";
import { AttrList } from "~/components/AttrList";
import { MyLink } from "~/components/MyLink";
import { addressUrl } from "~/lib/utils";
import { useTitle } from "~/hooks/useTitle";
import { useShortcut } from "~/hooks/useShortcut";
import { MyExpandable } from "~/components/MyExpandable";
import { ContactTile, ProjectTile } from "~/lib/tiles";
import { Remarks } from "~/components/Remarks";
import { EntityActivityTimeline } from "~/components/EntityActivityTimeline";

export default function CustomerDetailPage() {
  const { id } = useParams();

  const modals = useMyModals();
  const sessionInfo = useSessionInfo();

  const [customer, err] = useClientStream(() => client.streamQuery('customers.get', { id: id! }), [id]);
  const [contacts] = useClientStream(() => client.streamQuery('customers.contacts.list', { customerId: id! }), [id]);
  const [projects] = useClientStream(() => client.streamQuery('projects.list', { customerId: id! }), [id]);

  useTitle(() => customer ? customerName(customer) : null, [customer]);

  useShortcut('Control+e', e => {
    if (!customer || !sessionInfo.canDo('manage:customers')) return;
    e.preventDefault();
    showModifyCustomerModal(modals, customer);
  });

  if (err) return <NotFound reason="resourceNotFound" />
  if (!customer) return;

  return <>
    <MyHeader
      title={customerName(customer)}
      actions={<>
        <MyDropdown items={[
          {
            label: 'Bearbeiten',
            renderIcon: Icons.Edit,
            hideIf: !sessionInfo.canDo('manage:customers'),
            onClick: () => showModifyCustomerModal(modals, customer),
          },
          {
            label: 'Löschen',
            renderIcon: Icons.Delete,
            hideIf: !sessionInfo.canDo('delete:customers'),
            onClick: () => showDeleteCustomerModal(modals, customer),
          },
        ]} />
      </>}
    />

    <MyDivider />

    <AttrList>
      {!!customer.salutation && <AttrList.Attr name="Anrede" value={customer.salutation} />}
      <AttrList.Attr name="Name" value={customer.name} />
      {!!customer.address && <AttrList.Attr name="Anschrift" value={
        <MyLink to={addressUrl(customer.address)} target="_blank">{formatAddress(customer.address)}</MyLink>
      } />}
    </AttrList>

    <AttrList>
      {customer.emailAddresses.map(({ email, name }, i) => {
        return <AttrList.Attr key={i} name={name ?? `E-Mail ${i + 1}`} value={<MyLink to={`mailto:${email}`}>{email}</MyLink>} />
      })}
      {customer.phoneNumbers.map(({ number, name }, i) => {
        return <AttrList.Attr key={i} name={name ?? `Telefon ${i + 1}`} value={<MyLink to={`tel:${number}`}>{number}</MyLink>} />
      })}
    </AttrList>

    <MyDivider />

    <Remarks resourceType="customer" resourceId={customer.id} canManage={sessionInfo.canDo('manage:customers')} />

    <EntityActivityTimeline resourceType="customer" resourceId={customer.id} />

    {!!contacts?.length && <MyExpandable title={`Ansprechpartner (${contacts.length})`}>
      <div className="space-y-2">
        {contacts.map((contact) => <ContactTile key={contact.id} contact={contact} />)}
      </div>
    </MyExpandable>}

    {!!projects?.length && <MyExpandable title={`Projekte (${projects.length})`}>
      <div className="space-y-2">
        {projects.map((project) => <ProjectTile key={project.id} project={project} omit={['customer']} />)}
      </div>
    </MyExpandable>}
  </>;
}
