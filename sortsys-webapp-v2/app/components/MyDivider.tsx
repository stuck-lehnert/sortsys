export function MyDivider({ margin }: {
    margin?: string | number;
}) {
    margin ??= '1.2rem';

    return <div>
        <hr style={{ opacity: '30%', margin: `${margin} 0` }} />
    </div>;
}