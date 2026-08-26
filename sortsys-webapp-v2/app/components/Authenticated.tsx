import { useEffect } from "react";
import { Navigate } from "react-router";
import { useForceUpdate } from "~/hooks/useForceUpdate";
import { client } from "~/lib/client";

export function Authenticated<P extends object>(Component: React.FC<P>): React.FC<P> {
    return function (props: P) {
        const forceUpdate = useForceUpdate();
        useEffect(() => client.listenAuthState(forceUpdate), []);
        if (!client.loggedIn()) return <Navigate to="/auth/login" />;
        return <Component {...props} />;
    }
}

export function Unauthenticated<P extends object>(Component: React.FC<P>): React.FC<P> {
    return function (props: P) {
        const forceUpdate = useForceUpdate();
        useEffect(() => client.listenAuthState(forceUpdate), []);
        if (client.loggedIn()) return <Navigate to="/" />;
        return <Component {...props} />;
    }
}