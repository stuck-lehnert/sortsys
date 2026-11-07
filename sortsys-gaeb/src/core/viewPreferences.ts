export type GaebViewPreferences = {
  showFields: boolean;
  outlineOpen: boolean;
  outlineWidth: number;
  ribbonCollapsed: boolean;
  zoom: number | null;
};
export const DEFAULT_GAEB_VIEW: GaebViewPreferences = {
  showFields: true,
  outlineOpen: true,
  outlineWidth: 320,
  ribbonCollapsed: false,
  zoom: null,
};
export function localGaebView(): GaebViewPreferences {
  try {
    return {
      ...DEFAULT_GAEB_VIEW,
      ...JSON.parse(localStorage.getItem("sortsys-gaeb:view") ?? "{}"),
    };
  } catch {
    return { ...DEFAULT_GAEB_VIEW };
  }
}
