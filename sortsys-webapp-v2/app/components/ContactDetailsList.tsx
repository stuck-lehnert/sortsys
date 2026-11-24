import type { ReactNode } from "react";
import { formatAddress } from "~/lib/format";
import { uiText } from "~/lib/i18n";
import { addressUrl } from "~/lib/utils";
import type { Address, Contact } from "~/type-helpers";
import { AttrList } from "./AttrList";
import { MyLink } from "./MyLink";

export function AddressAttribute({ address }: { address: Address }) {
  return (
    <AttrList.Attr
      name={uiText("Anschrift", "Address")}
      value={
        <MyLink to={addressUrl(address)} target="_blank">
          {formatAddress(address)}
        </MyLink>
      }
    />
  );
}

export function ContactDetailsList({
  details,
  address,
  children,
}: {
  details: Pick<Contact, "emailAddresses" | "phoneNumbers">;
  address?: Address | null;
  children?: ReactNode;
}) {
  return (
    <AttrList>
      {children}
      {address && <AddressAttribute address={address} />}
      {details.emailAddresses.map(({ email, name }, i) => (
        <AttrList.Attr
          key={`email:${i}`}
          name={name ?? uiText(`E-Mail ${i + 1}`, `Email ${i + 1}`)}
          value={<MyLink to={`mailto:${email}`}>{email}</MyLink>}
        />
      ))}
      {details.phoneNumbers.map(({ number, name }, i) => (
        <AttrList.Attr
          key={`phone:${i}`}
          name={name ?? uiText(`Telefon ${i + 1}`, `Phone ${i + 1}`)}
          value={<MyLink to={`tel:${number}`}>{number}</MyLink>}
        />
      ))}
    </AttrList>
  );
}
