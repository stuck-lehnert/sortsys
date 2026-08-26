import type { HTMLAttributes, ReactNode } from "react";
import React from "react";

const AttrList = function(_props: {
    children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDListElement>, 'children'>) {
    const { children, ...props } = _props;

    const _children = React.Children.toArray(children).filter(React.isValidElement);
    if (!_children.length) return;

    return <dl {...props} className={`attr-list ${props.className ?? ''}`}>
        {children}
    </dl>
}

AttrList.Attr = function ({ name, value, third }: {
    name: ReactNode;
    value: ReactNode;
    third?: ReactNode;
}) {
    return <div className={`attr-list__row ${third ? 'attr-list__row--third' : ''}`}>
        <dt className="attr-list__label">{name}</dt>
        <dd className="attr-list__values">
            <span className="attr-list__value">{value}</span>
            {!!third && <span className="attr-list__value">{third}</span>}
        </dd>
    </div>;
}

export { AttrList };
