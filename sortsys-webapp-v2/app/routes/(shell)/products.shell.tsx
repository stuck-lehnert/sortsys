import { uiText } from "~/lib/i18n";
import { TabbedOutlet } from "~/components/TabbedOutlet";
import { useSessionInfo } from "~/hooks/useSessionInfo";

export default function ProductsShell() {
    const sessionInfo = useSessionInfo();

    const tabs = [
        {
            path: '/products',
            label: uiText("Produkte"),
            hideIf: !sessionInfo.canDo('view:products'),
        },
        {
            path: '/products/deliveryNotes',
            label: uiText("Lieferscheine"),
            hideIf: !sessionInfo.canDo('view:deliveryNotes'),
        },
        {
            path: '/products/vendors',
            label: uiText("Händler"),
            hideIf: !sessionInfo.canDo('view:productVendors'),
        },
    ];


    return <TabbedOutlet scope="products.content" tabs={tabs} />;
}
