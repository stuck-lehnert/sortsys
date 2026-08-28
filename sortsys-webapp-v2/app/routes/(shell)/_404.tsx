import { uiText } from "~/lib/i18n";
type Reason = 'pageNotFound' | 'resourceNotFound';

export function NotFound(props: {
    reason: Reason;
}) {
    const text = {
        'pageNotFound': uiText('Die angeforderte Seite existiert nicht.', 'The requested page does not exist.'),
        'resourceNotFound': uiText('Die angeforderte Ressource konnte nicht aufgelöst werden.', 'The requested resource could not be resolved.'),
    }[props.reason];

    return <div style={{ padding: '2rem' }}>
        <h1><b>404</b></h1>
        <p>{text}</p>
    </div>
}

export default function () {
    return <NotFound reason="pageNotFound" />
}