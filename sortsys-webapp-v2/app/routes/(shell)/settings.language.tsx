import { Tile } from '@sortsys/react-components';
import { useState } from 'react';
import { AutoHideSuccessCallout } from '~/components/AutoHideSuccessCallout';
import { MyForm, type MyPublicFormContext } from '~/components/MyForm';
import { client } from '~/lib/client';
import { uiText, useI18n } from '~/lib/i18n';

export function meta() {
  return [{ title: uiText("Sprache | Einstellungen", "Language | Settings") }];
}

export default function LanguageSettingsPage() {
  const { locale, setLocale, t } = useI18n();
  const [saved, setSaved] = useState(false);

  async function saveLanguage(context: MyPublicFormContext) {
    const value = context.getValues().locale;
    if (value !== 'de' && value !== 'en') return;

    const [, error] = await client.mutate('settings.language.set', { locale: value });
    if (error) throw error;

    await client.invalidate('auth.sessionInfo');
    setLocale(value);
    setSaved(true);
  }

  return <Tile className="settings-section">
    {saved && <AutoHideSuccessCallout
      resetKey={locale}
      onHidden={() => setSaved(false)}
    >
      {t('language.saved')}
    </AutoHideSuccessCallout>}

    <MyForm
      className="settings-form"
      notifyLoaded={context => context.setValues({ locale })}
      onSubmit={saveLanguage}
    >
      <MyForm.Select
        name="locale"
        labelText={t('language.label')}
        getOptions={() => [
          { id: 'de', label: t('language.de') },
          { id: 'en', label: t('language.en') },
        ]}
        buildOption={option => ({ value: option.id, text: option.label })}
      />
      <MyForm.SubmitButton>{t('common.save')}</MyForm.SubmitButton>
    </MyForm>
  </Tile>;
}
