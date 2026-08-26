import { useRef, useState, type ReactNode } from "react";
import { MyButton } from "~/components/MyButton";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { Icons } from "~/lib/icons";
import { generateId } from "~/lib/utils";

export function FormAddress({ required, children, initialChecked }: {
  required?: true;
  children?: ReactNode;
  initialChecked?: boolean;
}) {
  const context = MyForm.$useContext();

  const content = <>
    <div style={{ height: '0.5rem' }} />
    <MyForm.Input required name="streetAddress" labelText="Straße & Hausnummer" />
    <div className="flex gap-2">
      <MyForm.Input className="flex-1" name="zip" labelText="Postleitzahl" />
      <MyForm.Input className="flex-2" required name="city" labelText="Stadt" />
    </div>
    <MyForm.Input name="country" labelText="Land/Staat" />

    {children}
  </>;

  if (required) return content;

  const [useAddress, setUseAddress] = useState(initialChecked || false);

  return <>
    <MyForm.Checkbox name="__useAddress" labelText="Anschrift hinterlegen" onValueChange={setUseAddress} />
    <NotifyLoaded onLoad={() => context.field('__useAddress')?.setValue(initialChecked)} />

    {useAddress && content}
  </>
}

export function processFormAddress(values: any) {
  delete values['__useAddress'];

  if (values.streetAddress && values.city) {
    values.address = {
      streetAddress: values.streetAddress,
      city: values.city,
      zip: values.zip,
      country: values.country,
    };
  } else {
    values.address = null
  }
}

type ContactChannel = {
  name?: string | null;
};

type ContactPhoneNumber = ContactChannel & {
  number: string;
};

type ContactEmailAddress = ContactChannel & {
  email: string;
};

export function ContactChannelsFormFields({ phoneNumbers = [], emailAddresses = [] }: {
  phoneNumbers?: ContactPhoneNumber[];
  emailAddresses?: ContactEmailAddress[];
}) {
  const context = MyForm.$useContext();
  const [fields, setFields] = useState<['email' | 'phone', string][]>([]);
  const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);
  const initialValues = useRef<Record<string, [string | null, string]>>({}).current;

  return <>
    {fields.map(([kind, id]) => <div key={id} className="w-full flex gap-2 items-end">
      <div className="grow flex gap-2">
        <div className="basis-1/2 flex-1">
          <MyForm.Input
            name={`${kind}:${id}:name`}
            labelText="Bezeichnung"
            autoFocus={autoFocusFieldName === `${kind}:${id}:name`}
          />
        </div>

        <div className="basis-1/2 flex-1">
          <MyForm.Input
            required
            name={`${kind}:${id}:value`} labelText={kind === 'email' ? 'E-Mail' : 'Telefon'}
            suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title="Eintrag entfernen" aria-label="Eintrag entfernen" onClick={() => {
              context.field(`${kind}:${id}:name`)?.setValue('');
              context.field(`${kind}:${id}:value`)?.setValue('');
              setFields(fields => fields.filter(([, _id]) => _id !== id));
            }}><Icons.Delete /></MyButton>}
          />
        </div>
      </div>

      <NotifyLoaded onLoad={() => {
        if (!(id in initialValues)) return;
        context.field(`${kind}:${id}:name`)?.setValue(initialValues[id][0]);
        context.field(`${kind}:${id}:value`)?.setValue(initialValues[id][1]);
      }} />
    </div>)}

    <div className="flex gap-2">
      <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
        const id = generateId();
        setFields(fields => [...fields, ['email', id]]);
        setAutoFocusFieldName(`email:${id}:name`);
      }}>E-Mail</MyButton>

      <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
        const id = generateId();
        setFields(fields => [...fields, ['phone', id]]);
        setAutoFocusFieldName(`phone:${id}:name`);
      }}>Telefon</MyButton>
    </div>

    <NotifyLoaded onLoad={() => {
      const nextFields: typeof fields = [];
      phoneNumbers.forEach(({ name, number }) => {
        const id = generateId();
        nextFields.push(['phone', id]);
        initialValues[id] = [name ?? null, number];
      });
      emailAddresses.forEach(({ name, email }) => {
        const id = generateId();
        nextFields.push(['email', id]);
        initialValues[id] = [name ?? null, email];
      });
      setFields(nextFields);
    }} />
  </>;
}

export function processContactChannels(values: Record<string, any>) {
  const emailIds = new Set<string>();
  const phoneNumberIds = new Set<string>();

  Object.keys(values).forEach((key) => {
    if (key.startsWith('email:')) {
      const [, id] = key.split(':');
      emailIds.add(id);
    }

    if (key.startsWith('phone:')) {
      const [, id] = key.split(':');
      phoneNumberIds.add(id);
    }
  });

  const emailAddresses: { name: string | null; email: string }[] = [];
  emailIds.forEach(id => {
    const email = `${values[`email:${id}:value`] ?? ''}`.trim();
    if (!email) return;

    emailAddresses.push({
      name: `${values[`email:${id}:name`] ?? ''}`.trim() || null,
      email,
    });
  });

  const phoneNumbers: { name: string | null; number: string }[] = [];
  phoneNumberIds.forEach(id => {
    const number = `${values[`phone:${id}:value`] ?? ''}`.trim();
    if (!number) return;

    phoneNumbers.push({
      name: `${values[`phone:${id}:name`] ?? ''}`.trim() || null,
      number,
    });
  });

  return { emailAddresses, phoneNumbers };
}
