import { uiText } from "~/lib/i18n";
import { Fragment, useEffect, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyDivider } from "~/components/MyDivider";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { formatAddress, formatDate, formatNumber, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { renderStructuredPdfBatch, type PdfTableSection } from "~/lib/pdf";
import { dailyReportDayKey, SmallProjectTile, SmallUserTile } from "~/lib/tiles";
import { deliverBlob, downloadBlob, generateId, parseFloatCustom } from "~/lib/utils";
import type { DailyProjectReport, Project, User } from "~/type-helpers";

const WEEKDAY_NAMES = [
  'Montag',
  'Dienstag',
  'Mittwoch',
  'Donnerstag',
  'Freitag',
  'Samstag',
  'Sonntag',
] as const;

const WEEKDAY_SHORT_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;
type WeeklyExportFormat = 'excel' | 'pdf';

function startOfWeek(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);

  const dayOfWeek = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - dayOfWeek);
  return result;
}

function dayInWeek(weekStart: Date, dayIndex: number) {
  const result = new Date(weekStart);
  result.setDate(result.getDate() + dayIndex);
  return result;
}

function isoWeekNumber(date: Date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);

  const day = (value.getDay() + 6) % 7;
  value.setDate(value.getDate() + 3 - day);

  const firstThursday = new Date(value.getFullYear(), 0, 4);
  const firstDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() + 3 - firstDay);

  return 1 + Math.round((value.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
}

function sanitizeWorksheetName(value: string) {
  const cleaned = value.replace(/[:\\/?*\[\]]/g, ' ').trim();
  return (cleaned || 'Sheet').slice(0, 31);
}

function addUniqueWorksheet(workbook: any, baseName: string, usedNames: Set<string>) {
  let candidate = sanitizeWorksheetName(baseName);
  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return workbook.addWorksheet(candidate);
  }

  let index = 2;
  while (true) {
    const suffix = ` (${index})`;
    const truncated = sanitizeWorksheetName(candidate.slice(0, Math.max(1, 31 - suffix.length)) + suffix);
    if (!usedNames.has(truncated)) {
      usedNames.add(truncated);
      return workbook.addWorksheet(truncated);
    }

    index += 1;
  }
}

function formatWeeklyWorkHour(value: number) {
  const numeric = Number(value ?? 0);
  return numeric === 0 ? '-' : formatNumber(numeric);
}

function formatWeeklyPresence(value: number) {
  return Number(value ?? 0) > 0 ? 'X' : '-';
}

export function showCreateDailyProjectReportModal(modals: MyModalsInterface) {
  modals.showForm({
    content: ({ context }) => {
      const [workHourIds, setWorkHourIds] = useState<string[]>([]);
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);
      const createEntityAction = useCreateEntityAction(modals);

      useEffect(() => {
        const id = generateId();
        setWorkHourIds([id]);
        setAutoFocusFieldName(`workHour:${id}:user`);
      }, []);

      return <>
        <MyForm.MultiSelect
          minSelectedItems={1} maxSelectedItems={1}
          name="project" labelText={uiText("Projekt")}
          getOptions={async ({ query }) => {
            const [data, err] = await client.query('projects.list', { search: query });
            if (err) throw err;
            return data ?? [];
          }}
          renderItem={({ item }) => item.title}
          renderTile={item => <SmallProjectTile data={item} noLink />}
          createAction={createEntityAction.project}
        />
        <p className="light">{uiText("Wähle das Projekt, für das der Bautagesbericht erstellt wird.")}</p>

        <MyForm.Input textArea name="summary" labelText={uiText("Beschreibung der Arbeiten")} />

        <MyForm.DateInput
          required
          name="day"
          labelText={uiText("Tag")}
          rules={[date => {
            if (!date) return null;
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            if (date.getTime() > today.getTime()) return uiText('Datum darf nicht in der Zukunft liegen');
            return null;
          }]}
        />
        <p className="light">{uiText("Der Berichtstag darf nicht in der Zukunft liegen.")}</p>

        <MyDivider />

        <h4>{uiText("Arbeitszeit")}</h4>
        <p className="light">{uiText("Pro Eintrag einen Mitarbeiter und die geleisteten Stunden erfassen.")}</p>

        {workHourIds.map(id => {
          return <Fragment key={id}>
            <div className="flex flex-col gap-2">
              <MyForm.MultiSelect
                name={`workHour:${id}:user`}
                labelText={uiText("Mitarbeiter")}
                autoFocus={autoFocusFieldName === `workHour:${id}:user`}
                minSelectedItems={1} maxSelectedItems={1}
                getOptions={async ({ query }) => {
                  const [data, err] = await client.query('users.list', { search: query });
                  if (err) throw err;
                  return data ?? [];
                }}
                renderItem={({ item }) => userFullName(item)}
                renderTile={item => <SmallUserTile data={item} noLink />}
                createAction={createEntityAction.user}
              />

              <div className="flex gap-2 items-end">
                <div className="grow">
                  <MyForm.Input
                    required
                    name={`workHour:${id}:hours`}
                    labelText={uiText("Stunden")}
                    type="number"
                    rules={[
                      MyForm.Input.rules.posnum,
                      value => {
                        if (!value.trim()) return null;
                        const hours = parseFloatCustom(value);
                        if (isNaN(hours)) return null;
                        if (hours < 0 || hours > 10) return uiText('Stunden müssen zwischen 0 und 10 liegen', 'Hours must be between 0 and 10');
                        return null;
                      },
                    ]}
                    suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title={uiText("Arbeitszeit entfernen")} aria-label={uiText("Arbeitszeit entfernen")} onClick={() => {
                      setWorkHourIds(ids => ids.filter(_id => _id !== id));
                    }}><Icons.Delete /></MyButton>}
                  />
                </div>
              </div>
            </div>

            <div style={{ height: '1rem' }} />
          </Fragment>;
        })}

        <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
          const id = generateId();
          setWorkHourIds(ids => [...ids, id]);
          setAutoFocusFieldName(`workHour:${id}:user`);
        }}>{uiText("Arbeitszeit")}</MyButton>

        <MyDivider />

        <h4>{uiText("Wetter")}</h4>
        <p className="light">{uiText("Wetterangaben helfen bei der späteren Dokumentation.")}</p>

        <MyForm.Input name="weatherSummary" labelText={uiText("Wetterbeschreibung")} />

        <div className="flex gap-2">
          <MyForm.Input
            className="flex-1"
            name="temperatureC"
            labelText={uiText("Temperatur (°C)")}
            type="number"
            rules={[MyForm.Input.rules.num]}
          />

          <MyForm.Input
            className="flex-1"
            name="precipitationMm"
            labelText={uiText("Niederschlag (mm)")}
            type="number"
            rules={[MyForm.Input.rules.num]}
          />

          <MyForm.Input
            className="flex-1"
            name="windKph"
            labelText={uiText("Wind (km/h)")}
            type="number"
            rules={[MyForm.Input.rules.num]}
          />
        </div>

        <NotifyLoaded onLoad={() => {
          context.field('day')?.setValue(new Date());
        }} />
      </>;
    },
    onSubmit: async ({ context, hide, navigate, pathname }) => {
      const values = context.getValues();

      const projectId = values.project[0]?.id;
      if (!projectId) return;

      const dayInput = values.day ? new Date(values.day) : new Date();
      if (isNaN(dayInput.getTime())) throw new Error(uiText("Invalid day"));
      const day = dailyReportDayKey(dayInput);

      const workHours: {
        userId?: string | null;
        hours: number;
        costPerHour: number | null;
        contractType: User['contractType'];
      }[] = [];

      const workHourIds = new Set<string>();
      Object.keys(values).forEach(key => {
        if (!key.startsWith('workHour:')) return;
        const [, id] = key.split(':');
        workHourIds.add(id);
      });

      workHourIds.forEach(id => {
        const user = values[`workHour:${id}:user`]?.at(0) ?? null;

        const hours = parseFloatCustom(values[`workHour:${id}:hours`]);
        if (isNaN(hours)) throw new Error();

        workHours.push({
          userId: user?.id ?? null,
          hours,
          costPerHour: user?.costPerHour ?? null,
          contractType: user?.contractType ?? 'external',
        });
      });

      const [data, err] = await client.mutate('projects.dailyReports.create', {
        projectId,
        day,
        summary: `${values.summary ?? ''}`.trim() || null,
        weather: {
          summary: values.weatherSummary,
          temperatureC: values.temperatureC ? parseFloatCustom(values.temperatureC) : null,
          precipitationMm: values.precipitationMm ? parseFloatCustom(values.precipitationMm) : null,
          windKph: values.windKph ? parseFloatCustom(values.windKph) : null,
        },
        workHours,
      });

      if (err) throw err;
      if (!data) return;

      if (pathname !== `/projects/${projectId}`) navigate(`/projects/${projectId}`);
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Bautagesbericht erstellen"),
      primaryButtonText: uiText("Erstellen"),
    }),
  });
}

export function showCreateWeeklyDailyProjectReportModal(modals: MyModalsInterface) {
  modals.showForm({
    content: ({ context }) => {
      const [workHourIdsByDay, setWorkHourIdsByDay] = useState<Record<number, string[]>>(() => {
        return Object.fromEntries(WEEKDAY_NAMES.map((_, dayIndex) => [dayIndex, []])) as Record<number, string[]>;
      });
      const [selectedDayIndexes, setSelectedDayIndexes] = useState<number[]>(() => {
        return WEEKDAY_NAMES.map((_, dayIndex) => dayIndex);
      });
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);
      const createEntityAction = useCreateEntityAction(modals);

      const selectedDaySet = new Set(selectedDayIndexes);

      return <>
        <MyForm.MultiSelect
          minSelectedItems={1} maxSelectedItems={1}
          name="project" labelText={uiText("Projekt")}
          getOptions={async ({ query }) => {
            const [data, err] = await client.query('projects.list', { search: query });
            if (err) throw err;
            return data ?? [];
          }}
          renderItem={({ item }) => item.title}
          renderTile={item => <SmallProjectTile data={item} noLink />}
          createAction={createEntityAction.project}
        />
        <p className="light">{uiText("Wähle das Projekt, für das der Bauwochenbericht erstellt wird.")}</p>

        <MyForm.DateInput
          required
          name="week"
          labelText={uiText("Woche (beliebiger Tag)")}
          rules={[date => {
            if (!date) return null;
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            if (date.getTime() > today.getTime()) return uiText('Datum darf nicht in der Zukunft liegen');
            return null;
          }]}
        />
        <p className="light">{uiText("Wähle einen beliebigen Tag der Zielwoche; es wird automatisch auf Montag bis Sonntag erweitert.")}</p>

        <h4>{uiText("Einzutragende Tage")}</h4>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {WEEKDAY_NAMES.map((weekday, dayIndex) => (
            <MyForm.Checkbox
              key={weekday}
              name={`enabledDay:${dayIndex}`}
              labelText={weekday}
              onValueChange={(checked) => {
                setSelectedDayIndexes((indexes) => {
                  if (checked) {
                    if (indexes.includes(dayIndex)) return indexes;
                    return [...indexes, dayIndex].sort((left, right) => left - right);
                  }

                  return indexes.filter((index) => index !== dayIndex);
                });
              }}
            />
          ))}
        </div>

        <p className="light">{uiText("Die Woche beginnt am Montag. Nur ausgewählte und ausgefüllte Tage werden erstellt.")}</p>

        {!selectedDayIndexes.length && (
          <p className="light">{uiText("Bitte mindestens einen Tag auswählen.")}</p>
        )}

        <MyDivider />

        <h3 style={{ marginBottom: '0.25rem' }}>{uiText("Tagesberichte")}</h3>

        {WEEKDAY_NAMES.map((weekday, dayIndex) => {
          if (!selectedDaySet.has(dayIndex)) return null;

          const workHourIds = workHourIdsByDay[dayIndex] ?? [];

          return <Fragment key={weekday}>
            <h4 style={{ marginBottom: '0.25rem' }}>{weekday}</h4>

            <MyForm.Input
              textArea
              name={`day:${dayIndex}:summary`}
              labelText={uiText("Beschreibung der Arbeiten")}
            />

            <h6>{uiText("Arbeitszeit")}</h6>

            {workHourIds.map(id => {
              return <Fragment key={id}>
                <div className="flex flex-col gap-2">
                  <MyForm.MultiSelect
                    name={`day:${dayIndex}:workHour:${id}:user`}
                    labelText={uiText("Mitarbeiter")}
                    autoFocus={autoFocusFieldName === `day:${dayIndex}:workHour:${id}:user`}
                    minSelectedItems={1} maxSelectedItems={1}
                    getOptions={async ({ query }) => {
                      const [data, err] = await client.query('users.list', { search: query });
                      if (err) throw err;
                      return data ?? [];
                    }}
                    renderItem={({ item }) => userFullName(item)}
                    renderTile={item => <SmallUserTile data={item} noLink />}
                    createAction={createEntityAction.user}
                  />

                  <div className="flex gap-2 items-end">
                    <div className="grow">
                      <MyForm.Input
                        required
                        name={`day:${dayIndex}:workHour:${id}:hours`}
                        labelText={uiText("Stunden")}
                        type="number"
                        rules={[
                          MyForm.Input.rules.posnum,
                          value => {
                            if (!value.trim()) return null;
                            const hours = parseFloatCustom(value);
                            if (isNaN(hours)) return null;
                            if (hours < 0 || hours > 10) return uiText('Stunden müssen zwischen 0 und 10 liegen', 'Hours must be between 0 and 10');
                            return null;
                          },
                        ]}
                        suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title={uiText("Arbeitszeit entfernen")} aria-label={uiText("Arbeitszeit entfernen")} onClick={() => {
                          setWorkHourIdsByDay(map => ({
                            ...map,
                            [dayIndex]: (map[dayIndex] ?? []).filter(_id => _id !== id),
                          }));
                        }}><Icons.Delete /></MyButton>}
                      />
                    </div>
                  </div>
                </div>

                <div style={{ height: '0.75rem' }} />
              </Fragment>;
            })}

            <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
              const id = generateId();
              setWorkHourIdsByDay(map => ({
                ...map,
                [dayIndex]: [...(map[dayIndex] ?? []), id],
              }));
              setAutoFocusFieldName(`day:${dayIndex}:workHour:${id}:user`);
            }}>{uiText("Arbeitszeit")}</MyButton>

            <div style={{ height: '0.75rem' }} />

            <h6>{uiText("Wetter")}</h6>

            <MyForm.Input
              name={`day:${dayIndex}:weatherSummary`}
              labelText={uiText("Wetterbeschreibung")}
            />

            <div className="flex gap-2">
              <MyForm.Input
                className="flex-1"
                name={`day:${dayIndex}:temperatureC`}
                labelText={uiText("Temperatur (°C)")}
                type="number"
                rules={[MyForm.Input.rules.num]}
              />

              <MyForm.Input
                className="flex-1"
                name={`day:${dayIndex}:precipitationMm`}
                labelText={uiText("Niederschlag (mm)")}
                type="number"
                rules={[MyForm.Input.rules.num]}
              />

              <MyForm.Input
                className="flex-1"
                name={`day:${dayIndex}:windKph`}
                labelText={uiText("Wind (km/h)")}
                type="number"
                rules={[MyForm.Input.rules.num]}
              />
            </div>

            {dayIndex < WEEKDAY_NAMES.length - 1 && <>
              <div style={{ height: '1.25rem' }} />
              <MyDivider />
              <div style={{ height: '1.25rem' }} />
            </>}
          </Fragment>
        })}

        <NotifyLoaded onLoad={() => {
          context.setValues(Object.fromEntries(WEEKDAY_NAMES.map((_, dayIndex) => [
            `enabledDay:${dayIndex}`,
            true,
          ])) as Record<string, boolean>);
          context.field('week')?.setValue(new Date());
        }} />
      </>;
    },
    onSubmit: async ({ context, hide, navigate, pathname }) => {
      const values = context.getValues();

      const projectId = values.project[0]?.id;
      if (!projectId) return;

      const selectedDayIndexes = WEEKDAY_NAMES
        .map((_, dayIndex) => dayIndex)
        .filter((dayIndex) => !!values[`enabledDay:${dayIndex}`]);
      if (!selectedDayIndexes.length) {
        throw new Error(uiText("Bitte mindestens einen Tag auswählen"));
      }

      const weekInput = values.week ? new Date(values.week) : new Date();
      if (isNaN(weekInput.getTime())) throw new Error(uiText("Invalid week"));

      const weekStart = startOfWeek(weekInput);

      const today = new Date();
      today.setHours(23, 59, 59, 999);

      const parseNumber = (fieldName: string, dayLabel: string) => {
        const raw = values[fieldName];
        if (`${raw ?? ''}`.trim() === '') return null;

        const parsed = parseFloatCustom(raw);
        if (isNaN(parsed)) throw new Error(uiText(`${dayLabel}: Ungültiger Zahlenwert`, `${dayLabel}: Invalid number`));
        return parsed;
      };

      const records: {
        dayLabel: string;
        day: string;
        summary: string | null;
        weather: {
          summary?: string | null;
          temperatureC?: number | null;
          precipitationMm?: number | null;
          windKph?: number | null;
        } | null;
        workHours: {
          userId?: string | null;
          hours: number;
          costPerHour: number | null;
          contractType: User['contractType'];
        }[];
      }[] = [];

      for (let dayIndex = 0; dayIndex < WEEKDAY_NAMES.length; dayIndex++) {
        if (!selectedDayIndexes.includes(dayIndex)) continue;

        const dayLabel = WEEKDAY_NAMES[dayIndex];

        const summary = `${values[`day:${dayIndex}:summary`] ?? ''}`.trim();
        const weatherSummary = `${values[`day:${dayIndex}:weatherSummary`] ?? ''}`.trim();
        const temperatureC = parseNumber(`day:${dayIndex}:temperatureC`, dayLabel);
        const precipitationMm = parseNumber(`day:${dayIndex}:precipitationMm`, dayLabel);
        const windKph = parseNumber(`day:${dayIndex}:windKph`, dayLabel);

        const workHourIds = new Set<string>();
        Object.keys(values).forEach(key => {
          if (!key.startsWith(`day:${dayIndex}:workHour:`)) return;
          const [, , , id] = key.split(':');
          if (!id) return;
          workHourIds.add(id);
        });

        const workHours: {
          userId?: string | null;
          hours: number;
          costPerHour: number | null;
          contractType: User['contractType'];
        }[] = [];
        workHourIds.forEach(id => {
          const user = values[`day:${dayIndex}:workHour:${id}:user`]?.at(0) ?? null;
          if (!user?.id) throw new Error(`${dayLabel}: Mitarbeiter fehlt`);

          const hours = parseFloatCustom(values[`day:${dayIndex}:workHour:${id}:hours`]);
          if (isNaN(hours) || hours < 0 || hours > 10) {
            throw new Error(uiText(`${dayLabel}: Stunden müssen zwischen 0 und 10 liegen`, `${dayLabel}: Hours must be between 0 and 10`));
          }

          workHours.push({
            userId: user.id,
            hours,
            costPerHour: user.costPerHour ?? null,
            contractType: user.contractType,
          });
        });

        const hasInput =
          !!summary ||
          !!weatherSummary ||
          temperatureC !== null ||
          precipitationMm !== null ||
          windKph !== null ||
          !!workHours.length;
        if (!hasInput) continue;
        if (!workHours.length) throw new Error(uiText(`${dayLabel}: Mindestens eine Arbeitszeit erforderlich`, `${dayLabel}: At least one time entry is required`));

        const day = dayInWeek(weekStart, dayIndex);
        if (day.getTime() > today.getTime()) {
          throw new Error(uiText(`${dayLabel}: Datum darf nicht in der Zukunft liegen`, `${dayLabel}: Date cannot be in the future`));
        }

        const hasWeather =
          !!weatherSummary ||
          temperatureC !== null ||
          precipitationMm !== null ||
          windKph !== null;

        records.push({
          dayLabel,
          day: dailyReportDayKey(day),
          summary: summary || null,
          weather: hasWeather
            ? {
                summary: weatherSummary || null,
                temperatureC,
                precipitationMm,
                windKph,
              }
            : null,
          workHours,
        });
      }

      if (!records.length) throw new Error(uiText("Bitte mindestens einen Tagesbericht ausfüllen"));

      const weekEnd = dayInWeek(weekStart, WEEKDAY_NAMES.length - 1);
      const [existingReports, existingReportsErr] = await client.query('projects.dailyReports.list', {
        projectId,
        from: dailyReportDayKey(weekStart),
        to: dailyReportDayKey(weekEnd),
      });
      if (existingReportsErr) throw existingReportsErr;

      const existingDays = new Set((existingReports ?? []).map(report => dailyReportDayKey(report.day)));
      const duplicateDays = records
        .filter(record => existingDays.has(record.day))
        .map(record => record.dayLabel);
      if (duplicateDays.length) {
        throw new Error(uiText(`Es existieren bereits Bautagesberichte für: ${duplicateDays.join(', ')}`, `Daily reports already exist for: ${duplicateDays.join(', ')}`));
      }

      for (const record of records) {
        const [data, err] = await client.mutate('projects.dailyReports.create', {
          projectId,
          day: record.day,
          summary: record.summary,
          weather: record.weather,
          workHours: record.workHours,
        });

        if (err) throw err;
        if (!data) return;
      }

      const overviewPath = `/projects/${projectId}/dailyReports`;
      if (pathname !== overviewPath) navigate(overviewPath);
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Bauwochenbericht erstellen"),
      primaryButtonText: uiText("Erstellen"),
    }),
  });
}

export function showExportWeeklyDailyProjectReportsModal(
  modals: MyModalsInterface,
  project: Project,
  format: WeeklyExportFormat = 'excel',
) {
  modals.showForm({
    content: () => <>
      <p className="light">{uiText("Es werden alle vorhandenen Bauwochenberichte des Projekts exportiert, nach Kalenderwoche aufsteigend.")}</p>
      <p className="light">{uiText("PDF: eine Datei mit Seitenumbruch nach jeder Woche. Excel: eine Arbeitsmappe mit einem Tabellenblatt je Woche.")}</p>
      <MyForm.Checkbox name="hideHours" labelText={uiText("Stunden ausblenden")} />
    </>,
    onSubmit: async ({ hide, context }) => {
      const hideHours = !!context.getValues().hideHours;
      const [reports, reportsErr] = await client.query('projects.dailyReports.list', {
        projectId: project.id,
        limit: 10000,
        offset: 0,
      });
      if (reportsErr) throw reportsErr;

      const reportList = (reports ?? [])
        .slice()
        .sort((left, right) => {
          const dayDiff = new Date(left.day).getTime() - new Date(right.day).getTime();
          if (dayDiff !== 0) return dayDiff;
          return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
        });

      if (!reportList.length) {
        throw new Error(uiText("Für dieses Projekt sind keine Bautagesberichte vorhanden"));
      }

      const userIds = [...new Set(
        reportList
          .flatMap((report) => report.workHours)
          .map((entry) => entry.userId)
          .filter(Boolean),
      )] as string[];
      const userEntries = await Promise.all(userIds.map(async (userId) => {
        const [user] = await client.query('users.get', { id: userId }, { strategy: 'cache-first' });
        return [userId, user ?? null] as const;
      }));
      const usersById = new Map(userEntries);

      const weeksByStart = new Map<string, { weekStart: Date; reports: DailyProjectReport[] }>();
      reportList.forEach((report) => {
        const day = new Date(report.day);
        day.setHours(0, 0, 0, 0);
        const weekStart = startOfWeek(day);
        const key = dailyReportDayKey(weekStart);
        const existing = weeksByStart.get(key) ?? { weekStart, reports: [] };
        existing.reports.push(report);
        weeksByStart.set(key, existing);
      });

      const weeklyExports = Array.from(weeksByStart.values())
        .sort((left, right) => left.weekStart.getTime() - right.weekStart.getTime())
        .map(({ weekStart, reports: weekReports }) => {
          const orderedWeekReports = weekReports
            .slice()
            .sort((left, right) => new Date(left.day).getTime() - new Date(right.day).getTime());

          const weekEnd = dayInWeek(weekStart, WEEKDAY_NAMES.length - 1);
          const weekNumber = isoWeekNumber(weekStart);

          const hoursByUser = new Map<string, { name: string; values: number[] }>();
          orderedWeekReports.forEach((report) => {
            const day = new Date(report.day);
            day.setHours(0, 0, 0, 0);

            const dayIndex = Math.floor((day.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000));
            if (dayIndex < 0 || dayIndex >= WEEKDAY_NAMES.length) return;

            report.workHours.forEach((entry) => {
              const key = entry.userId ?? '__unknown__';
              const user = entry.userId ? usersById.get(entry.userId) : null;
              const name = user ? userFullName(user) : 'Unbekannt';

              const current = hoursByUser.get(key) ?? {
                name,
                values: Array.from({ length: WEEKDAY_NAMES.length }, () => 0),
              };

              current.values[dayIndex] += Number(entry.hours ?? 0);
              hoursByUser.set(key, current);
            });
          });

          const workerRows = Array.from(hoursByUser.values())
            .sort((left, right) => left.name.localeCompare(right.name, 'de'));

          const reportSummaryByDay = new Map<number, string[]>();
          orderedWeekReports.forEach((report) => {
            const day = new Date(report.day);
            day.setHours(0, 0, 0, 0);

            const dayIndex = Math.floor((day.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000));
            if (dayIndex < 0 || dayIndex >= WEEKDAY_NAMES.length) return;

            const summaries = reportSummaryByDay.get(dayIndex) ?? [];
            const summary = `${report.summary ?? ''}`.trim();
            if (summary) summaries.push(summary);
            reportSummaryByDay.set(dayIndex, summaries);
          });
          const enteredDayIndexes = Array.from(reportSummaryByDay.keys()).sort((left, right) => left - right);

          const summaryRows: string[][] = [
            [uiText('Projekt'), project.title],
            ['Kalenderwoche', `KW ${weekNumber}`],
            [uiText('Zeitraum'), uiText(`${formatDate(weekStart, 'long')} bis ${formatDate(weekEnd, 'long')}`, `${formatDate(weekStart, 'long')} to ${formatDate(weekEnd, 'long')}`)],
            ['Berichtstage', `${orderedWeekReports.length}`],
          ];
          if (project.address) {
            summaryRows.splice(1, 0, ['Anschrift', formatAddress(project.address)]);
          }

          const totalHours = workerRows.reduce((sum, row) => {
            return sum + row.values.reduce((acc, value) => acc + Number(value ?? 0), 0);
          }, 0);
          if (!hideHours) {
            summaryRows.push(['Gesamtstunden', formatNumber(totalHours)]);
          }

          const sections: PdfTableSection[] = [
            {
              title: uiText("Zusammenfassung"),
              columns: [uiText('Kennzahl'), uiText('Wert')],
              rows: summaryRows,
              withHeader: false,
              align: ['left', 'left'],
              columnWidths: ['1fr', '2fr'],
            },
          ];

          if (workerRows.length > 0) {
            const workerColumns = hideHours
              ? ['Mitarbeiter', ...WEEKDAY_SHORT_NAMES]
              : ['Mitarbeiter', ...WEEKDAY_SHORT_NAMES, 'Gesamt'];
            const workerAlign = hideHours
              ? ['left' as const, ...WEEKDAY_SHORT_NAMES.map(() => 'center' as const)]
              : ['left' as const, ...WEEKDAY_SHORT_NAMES.map(() => 'right' as const), 'right' as const];
            const workerColumnWidths = hideHours
              ? ['2fr', ...WEEKDAY_SHORT_NAMES.map(() => '0.68fr')]
              : ['2fr', ...WEEKDAY_SHORT_NAMES.map(() => '0.68fr'), '0.82fr'];

            sections.push({
              title: hideHours ? uiText("Anwesenheit je Mitarbeiter und Tag") : uiText("Arbeitszeit je Mitarbeiter und Tag"),
              columns: workerColumns,
              rows: workerRows.map((row) => {
                const total = row.values.reduce((sum, value) => sum + Number(value ?? 0), 0);
                if (hideHours) return [row.name, ...row.values.map(value => formatWeeklyPresence(value))];
                return [row.name, ...row.values.map(value => formatWeeklyWorkHour(value)), formatWeeklyWorkHour(total)];
              }),
              align: workerAlign,
              columnWidths: workerColumnWidths,
            });
          }

          const workDescriptionRows = enteredDayIndexes.map((dayIndex) => {
            const weekday = WEEKDAY_NAMES[dayIndex]!;
            const dayDate = dayInWeek(weekStart, dayIndex);
            const summaries = (reportSummaryByDay.get(dayIndex) ?? []).join(' / ').trim();
            return [`${weekday}, ${formatDate(dayDate, 'long')}`, summaries || uiText('Keine Beschreibung')];
          });
          if (workDescriptionRows.length > 0) {
            sections.push({
              title: uiText("Beschreibung der Arbeiten"),
              columns: ['Tag', 'Inhalt'],
              rows: workDescriptionRows,
              withHeader: false,
              align: ['left', 'left'],
              columnWidths: ['1.25fr', '2.75fr'],
            });
          }

          return {
            weekStart,
            weekEnd,
            weekNumber,
            reports: orderedWeekReports,
            workerRows,
            reportSummaryByDay,
            enteredDayIndexes,
            sections,
          };
        });

      const safeTitle = project.title.replace(/[^\w\-]+/g, '-');

      if (format === 'pdf') {
        const documents = weeklyExports.map((weeklyExport) => {
          return {
            title: `${project.title} — KW ${weeklyExport.weekNumber}`,
            reportLabel: uiText("Bauwochenbericht"),
            sections: weeklyExport.sections,
            emptyMessage: uiText("Keine Daten zum Bauwochenbericht verfügbar."),
          };
        });

        const pdfData = await renderStructuredPdfBatch({ documents });
        const blob = new Blob([pdfData] as any, { type: 'application/pdf' });
        deliverBlob(blob, `Bauwochenberichte-${safeTitle}.pdf`);
        hide();
        return;
      }

      const ExcelJS = await import('exceljs');
      const DECIMAL_ZERO_DASH_NUM_FMT = '#,##0.00;-#,##0.00;-';
      const wb = new ExcelJS.Workbook();
      wb.creator = 'exceljs';
      wb.created = new Date();

      const usedWorksheetNames = new Set<string>();

      weeklyExports.forEach((weeklyExport, weekIndex) => {
        const worksheetName = `KW ${weeklyExport.weekNumber} ${dailyReportDayKey(weeklyExport.weekStart)}`;
        const ws = addUniqueWorksheet(wb, worksheetName, usedWorksheetNames);

        const headerLines = [
          uiText(`Projekt: ${project.title}`, `Project: ${project.title}`),
          project.address ? `Anschrift: ${formatAddress(project.address)}` : null,
          `Kalenderwoche: KW ${weeklyExport.weekNumber}`,
          `Wochenbeginn: ${formatDate(weeklyExport.weekStart)}`,
          `Wochenende: ${formatDate(weeklyExport.weekEnd)}`,
        ].filter(Boolean) as string[];

        ws.getCell(1, 1).value = 'Bauwochenbericht';
        ws.getCell(1, 1).font = { size: 18, bold: true };
        ws.mergeCells(1, 1, 1, 8);

        headerLines.forEach((line, index) => {
          const row = 2 + index;
          ws.getCell(row, 1).value = line;
          ws.getCell(row, 1).font = { size: 12, italic: index < 2 };
          ws.mergeCells(row, 1, row, 8);
        });

        let cursor = 3 + headerLines.length;
        ws.getCell(cursor, 1).value = hideHours ? uiText('Anwesenheit je Mitarbeiter und Tag') : uiText('Arbeitszeit je Mitarbeiter und Tag');
        ws.getCell(cursor, 1).font = { bold: true, size: 14 };

        cursor += 2;

        if (weeklyExport.workerRows.length) {
          const tableRows = weeklyExport.workerRows.map((row) => [
            row.name,
            ...row.values.map((value) => hideHours ? formatWeeklyPresence(value) : value),
          ]);

          ws.addTable({
            name: `WeeklyDailyReports_${dailyReportDayKey(weeklyExport.weekStart).replace(/[^0-9]/g, '')}_${weekIndex + 1}`,
            ref: ws.getCell(cursor, 1).address,
            headerRow: true,
            totalsRow: false,
            style: { theme: 'TableStyleLight1', showRowStripes: true },
            columns: [{ name: 'Mitarbeiter' }, ...WEEKDAY_SHORT_NAMES.map((day) => ({ name: day }))],
            rows: tableRows,
          });

          if (!hideHours) {
            for (let rowIndex = 0; rowIndex < weeklyExport.workerRows.length; rowIndex++) {
              const row = cursor + 1 + rowIndex;
              for (let dayIndex = 0; dayIndex < WEEKDAY_SHORT_NAMES.length; dayIndex++) {
                ws.getCell(row, 2 + dayIndex).numFmt = DECIMAL_ZERO_DASH_NUM_FMT;
              }
            }
          }

          cursor += tableRows.length + 3;
        } else {
          cursor += 1;
        }

        ws.getCell(cursor, 1).value = uiText('Beschreibung der Arbeiten');
        ws.getCell(cursor, 1).font = { bold: true, size: 14 };

        cursor += 2;

        weeklyExport.enteredDayIndexes.forEach((dayIndex) => {
          const weekday = WEEKDAY_NAMES[dayIndex]!;
          ws.getCell(cursor, 1).value = weekday;
          ws.getCell(cursor, 1).font = { bold: true, size: 12 };
          ws.mergeCells(cursor, 1, cursor, 8);

          cursor += 1;

          const summary = (weeklyExport.reportSummaryByDay.get(dayIndex) ?? []).join('\n\n').trim() || uiText('Keine Beschreibung');
          const summaryHeight = Math.max(2, Math.ceil((summary.length / 90) * 3));
          const summaryEndRow = cursor + summaryHeight - 1;

          ws.mergeCells(cursor, 1, summaryEndRow, 8);
          ws.getCell(cursor, 1).value = summary;
          ws.getCell(cursor, 1).alignment = { wrapText: true, vertical: 'top' };

          for (let row = cursor; row <= summaryEndRow; row++) {
            ws.getRow(row).height = 16;
          }

          cursor = summaryEndRow + 2;
        });

        ws.columns = [
          { width: 28 },
          { width: 11 },
          { width: 11 },
          { width: 11 },
          { width: 11 },
          { width: 11 },
          { width: 11 },
          { width: 11 },
        ];
      });

      const bytes = (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;
      const blob = new Blob([bytes] as any, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      downloadBlob(blob, `Bauwochenberichte-${safeTitle}.xlsx`);
      hide();
    },
    modalProps: () => ({
      noFullscreen: true,
      modalHeading: format === 'pdf'
        ? uiText("Bauwochenberichte als PDF exportieren")
        : uiText("Bauwochenberichte als Excel exportieren"),
      modalLabel: project.title,
      primaryButtonText: uiText("Exportieren"),
    }),
  });
}

export function showModifyDailyProjectReportModal(modals: MyModalsInterface, report: DailyProjectReport) {
  const initialWorkHourValues: Record<string, {
    user: User | null;
    userId: string | null;
    hours: number;
    costPerHour: number | null;
    contractType: User['contractType'];
  }> = {};

  modals.showForm({
    content: ({ context }) => {
      const [workHourIds, setWorkHourIds] = useState<string[]>([]);
      const [autoFocusFieldName, setAutoFocusFieldName] = useState<string | null>(null);
      const createEntityAction = useCreateEntityAction(modals);

      return <>
        <MyForm.MultiSelect
          minSelectedItems={1} maxSelectedItems={1}
          name="project" labelText={uiText("Projekt")}
          disabled
          getOptions={async ({ query }) => {
            const [data, err] = await client.query('projects.list', { search: query });
            if (err) throw err;
            return data ?? [];
          }}
          renderItem={({ item }) => item.title}
          renderTile={item => <SmallProjectTile data={item} noLink />}
          renderTileDisallowUndo
        />
        <p className="light">{uiText("Projekt ist bei bestehenden Berichten fix. Der Tag kann geändert werden.")}</p>

        <MyForm.Input textArea name="summary" labelText={uiText("Beschreibung der Arbeiten")} />

        <MyForm.DateInput required name="day" labelText={uiText("Tag")} />

        <MyDivider />

        <h4>{uiText("Arbeitszeit")}</h4>
        <p className="light">{uiText("Pro Eintrag einen Mitarbeiter und die geleisteten Stunden erfassen.")}</p>

        {workHourIds.map(id => {
          return <Fragment key={id}>
            <div className="flex flex-col gap-2">
              <MyForm.MultiSelect
                name={`workHour:${id}:user`}
                labelText={uiText("Mitarbeiter")}
                autoFocus={autoFocusFieldName === `workHour:${id}:user`}
                minSelectedItems={1} maxSelectedItems={1}
                getOptions={async ({ query }) => {
                  const [data, err] = await client.query('users.list', { search: query });
                  if (err) throw err;
                  return data ?? [];
                }}
                renderItem={({ item }) => userFullName(item)}
                renderTile={item => <SmallUserTile data={item} noLink />}
                createAction={createEntityAction.user}
              />

              <div className="flex gap-2 items-end">
                <div className="grow">
                  <MyForm.Input
                    required
                    name={`workHour:${id}:hours`}
                    labelText={uiText("Stunden")}
                    type="number"
                    rules={[
                      MyForm.Input.rules.posnum,
                      value => {
                        if (!value.trim()) return null;
                        const hours = parseFloatCustom(value);
                        if (isNaN(hours)) return null;
                        if (hours < 0 || hours > 10) return uiText('Stunden müssen zwischen 0 und 10 liegen', 'Hours must be between 0 and 10');
                        return null;
                      },
                    ]}
                    suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title={uiText("Arbeitszeit entfernen")} aria-label={uiText("Arbeitszeit entfernen")} onClick={() => {
                      setWorkHourIds(ids => ids.filter(_id => _id !== id));
                    }}><Icons.Delete /></MyButton>}
                  />
                </div>
              </div>
            </div>

            <NotifyLoaded onLoad={() => {
              const initial = initialWorkHourValues[id];
              if (!initial) return;

              const values: Record<string, any> = {
                [`workHour:${id}:hours`]: initial.hours,
              };
              if (initial.user) values[`workHour:${id}:user`] = [initial.user];
              context.setValues(values);
            }} />

            <div style={{ height: '1rem' }} />
          </Fragment>;
        })}

        <MyButton kind="secondary" renderIcon={Icons.Plus} onClick={() => {
          const id = generateId();
          setWorkHourIds(ids => [...ids, id]);
          setAutoFocusFieldName(`workHour:${id}:user`);
        }}>{uiText("Arbeitszeit")}</MyButton>

        <MyDivider />

        <h4>{uiText("Wetter")}</h4>
        <p className="light">{uiText("Wetterangaben helfen bei der späteren Dokumentation.")}</p>

        <MyForm.Input name="weatherSummary" labelText={uiText("Wetterbeschreibung")} />

        <div className="flex gap-2">
          <MyForm.Input
            className="flex-1"
            name="temperatureC"
            labelText={uiText("Temperatur (°C)")}
            type="number"
            rules={[MyForm.Input.rules.num]}
          />

          <MyForm.Input
            className="flex-1"
            name="precipitationMm"
            labelText={uiText("Niederschlag (mm)")}
            type="number"
            rules={[MyForm.Input.rules.num]}
          />

          <MyForm.Input
            className="flex-1"
            name="windKph"
            labelText={uiText("Wind (km/h)")}
            type="number"
            rules={[MyForm.Input.rules.num]}
          />
        </div>

        <NotifyLoaded onLoad={async () => {
          context.setValues({
            summary: report.summary ?? '',
            day: report.day,
            weatherSummary: report.weather?.summary ?? '',
            temperatureC: report.weather?.temperatureC ?? '',
            precipitationMm: report.weather?.precipitationMm ?? '',
            windKph: report.weather?.windKph ?? '',
          });

          if (report.projectId) {
            const [project] = await client.query('projects.get', { id: report.projectId }, { strategy: 'cache-first' });
            if (project) context.setValues({ project: [project] });
          }

          const ids: string[] = [];
          for (const record of report.workHours ?? []) {
            const id = generateId();
            ids.push(id);

            let user: any | null = null;
            if (record.userId) {
              const [data] = await client.query('users.get', { id: record.userId }, { strategy: 'cache-first' });
              user = data ?? null;
            }

            initialWorkHourValues[id] = {
              user,
              userId: record.userId ?? null,
              hours: record.hours,
              costPerHour: record.costPerHour ?? null,
              contractType: ((record as any).contractType ?? 'external') as User['contractType'],
            };
          }

          setWorkHourIds(ids);
        }} />
      </>;
    },
    onSubmit: async ({ context, hide, navigate, pathname }) => {
      const values = context.getValues();
      const nextDay = values.day instanceof Date ? values.day : report.day;
      const nextDayKey = dailyReportDayKey(nextDay);
      const oldDayKey = dailyReportDayKey(report.day);

      const workHours: {
        userId?: string | null;
        hours: number;
        costPerHour: number | null;
        contractType: User['contractType'];
      }[] = [];

      const workHourIds = new Set<string>();
      Object.keys(values).forEach(key => {
        if (!key.startsWith('workHour:')) return;
        const [, id] = key.split(':');
        workHourIds.add(id);
      });

      workHourIds.forEach(id => {
        const user = values[`workHour:${id}:user`]?.at(0);
        const initial = initialWorkHourValues[id];

        const hours = parseFloatCustom(values[`workHour:${id}:hours`]);
        if (isNaN(hours)) throw new Error();

        const initialUserId = initial?.userId ?? null;
        const currentUserId = user?.id ?? null;
        const userChanged = initialUserId !== currentUserId;
        const costPerHour = initial && !userChanged
          ? initial.costPerHour ?? null
          : user?.costPerHour ?? null;
        const contractType = initial && !userChanged
          ? initial.contractType
          : user?.contractType ?? 'external';

        workHours.push({
          userId: user?.id ?? null,
          hours,
          costPerHour,
          contractType,
        });
      });

      const [data, err] = await client.mutate('projects.dailyReports.update', {
        projectId: report.projectId,
        day: dailyReportDayKey(report.day),
        data: {
          day: nextDayKey,
          summary: `${values.summary ?? ''}`.trim() || null,
          weather: {
            summary: values.weatherSummary,
            temperatureC: values.temperatureC ? parseFloatCustom(values.temperatureC) : null,
            precipitationMm: values.precipitationMm ? parseFloatCustom(values.precipitationMm) : null,
            windKph: values.windKph ? parseFloatCustom(values.windKph) : null,
          },
          workHours,
        },
      });

      if (err) throw err;
      if (!data) return;

      const oldDetailPath = `/projects/${report.projectId}/dailyReports/${oldDayKey}`;
      const nextDetailPath = `/projects/${report.projectId}/dailyReports/${nextDayKey}`;
      if (oldDetailPath !== nextDetailPath && pathname === oldDetailPath) navigate(nextDetailPath);
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Bautagesbericht bearbeiten"),
      modalLabel: formatDate(report.day),
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showDeleteDailyProjectReportModal(modals: MyModalsInterface, report: DailyProjectReport) {
  modals.showForm({
    content: () => <>
      <p className="light">{uiText("Alle mit diesem Bautagesbericht in Verbindung stehenden Daten werden damit ebenfalls gelöscht.")}{" "}<b>{uiText("Diese Aktion kann nicht rückgängig gemacht werden.")}</b>
      </p>
      <MyForm.Checkbox
        required name="_understood"
        labelText={uiText("Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann.")}
      />
    </>,
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [data, err] = await client.mutate('projects.dailyReports.delete', {
        projectId: report.projectId,
        day: dailyReportDayKey(report.day),
      });
      if (err) throw err;
      if (!data) return;

      const overviewPath = `/projects/${report.projectId}/dailyReports`;
      if (pathname !== overviewPath) navigate(overviewPath);
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Bautagesbericht löschen"),
      modalLabel: formatDate(report.day),
      primaryButtonText: uiText("Löschen"),
    }),
  });
}
