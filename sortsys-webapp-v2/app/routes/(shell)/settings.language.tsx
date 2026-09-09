import { Tile, useNotifications } from '@sortsys/react-components';
import { MyForm, type MyPublicFormContext } from '~/components/MyForm';
import { client } from '~/lib/client';
import { uiText, useI18n } from '~/lib/i18n';

export function meta() {
  return [{ title: uiText("Sprache | Einstellungen", "Language | Settings") }];
}

export default function LanguageSettingsPage() {
  const { locale, setLocale, t } = useI18n();
  const notifications = useNotifications();

  async function saveLanguage(context: MyPublicFormContext) {
    const value = context.getValues().locale;
    if (value !== 'de' && value !== 'en') return;

    const [, error] = await client.mutate('settings.language.set', { locale: value });
    if (error) throw error;

    await client.invalidate('auth.sessionInfo');
    setLocale(value);
    notifications.success({
      title: uiText("Die Sprache wurde gespeichert", "Language saved"),
    });
  }

  return <Tile className="settings-section">
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
