import { useParams } from "react-router";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { NotFound } from "./_404";
import { MyHeader } from "~/components/MyHeader";
import { MyDropdown } from "~/components/MyDropdown";
import { Icons } from "~/lib/icons";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { showDeleteProductVendorModal, showModifyProductVendorModal } from "~/modals/productVendors";

export default function ProductVendorDetailPage() {
  const { id } = useParams();

  const modals = useMyModals();
  const sessionInfo = useSessionInfo();

  const [vendor, err] = useClientStream(() => client.streamQuery('products.vendors.get', { id: id! }), [id]);

  useShortcut('Control+e', e => {
    if (!vendor || !sessionInfo.canDo('manage:productVendors')) return;
    e.preventDefault();
    showModifyProductVendorModal(modals, vendor);
  });

  if (err) return <NotFound reason="resourceNotFound" />;
  if (!vendor) return;

  return <>
    <MyHeader
      title={vendor.name}
      actions={<MyDropdown items={[
        {
          label: 'Bearbeiten',
          renderIcon: Icons.Edit,
          hideIf: !sessionInfo.canDo('manage:productVendors'),
          onClick: () => showModifyProductVendorModal(modals, vendor),
        },
        {
          label: 'Löschen',
          renderIcon: Icons.Delete,
          hideIf: !sessionInfo.canDo('delete:productVendors'),
          onClick: () => showDeleteProductVendorModal(modals, vendor),
        },
      ]} />}
    />
  </>;
}
