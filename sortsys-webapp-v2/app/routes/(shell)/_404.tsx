type Reason = 'pageNotFound' | 'resourceNotFound';

export function NotFound(props: {
    reason: Reason;
}) {
    const text = {
        'pageNotFound': 'Die angeforderte Seite existiert nicht.',
        'resourceNotFound': 'Die angeforderte Ressource konnte nicht aufgelöst werden.',
    }[props.reason];

    return <div style={{ padding: '2rem' }}>
        <h1><b>404</b></h1>
        <p>{text}</p>
    </div>
}

export default function () {
    return <NotFound reason="pageNotFound" />
}