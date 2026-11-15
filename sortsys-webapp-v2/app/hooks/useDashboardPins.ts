import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { dashboardPreferences } from "~/lib/client";
import { listenCryptoSession, unlockedAccount } from "~/lib/crypto/session";
import { importLegacyDashboardPins } from "~/lib/data/legacyDashboardPins";
import type { DashboardPin } from "~/lib/data/personalHistoryData";
import { useSessionInfo } from "./useSessionInfo";

export function useDashboardPins() {
  const account = useSyncExternalStore(
      listenCryptoSession,
      unlockedAccount,
      () => null,
    ),
    session = useSessionInfo();
  const [state, setState] = useState<{
    account: typeof account;
    rows: DashboardPin[];
    error: boolean;
  } | null>(null);
  const revision = useRef(0),
    failures = useRef({ account, migration: false, write: false });
  useEffect(() => {
    if (!account || account.username !== session.user.username) return;
    let active = true;
    revision.current++;
    if (failures.current.account !== account)
      failures.current = { account, migration: false, write: false };
    const live = () => {
      if (!active || account !== unlockedAccount())
        throw new Error("Account changed");
    };
    const failed = () =>
      failures.current.account === account &&
      (failures.current.migration || failures.current.write);
    const reload = () => {
      const expected = ++revision.current;
      void dashboardPreferences
        .get()
        .then((rows) => {
          live();
          if (expected === revision.current)
            setState({ account, rows, error: failed() });
        })
        .catch(() => {
          if (
            active &&
            expected === revision.current &&
            account === unlockedAccount()
          )
            setState((current) => ({
              account,
              rows: current?.account === account ? current.rows : [],
              error: true,
            }));
        });
    };
    const stop = dashboardPreferences.listen(reload);
    void (async () => {
      try {
        await importLegacyDashboardPins(
          window.localStorage,
          account.tenant,
          session.user.id,
          dashboardPreferences.importLocal,
          live,
        );
        live();
        reload();
      } catch {
        if (active && account === unlockedAccount()) {
          failures.current.migration = true;
          reload();
          setState({ account, rows: [], error: true });
        }
      }
    })();
    return () => {
      active = false;
      revision.current++;
      stop();
    };
  }, [account, session.user.id, session.user.username]);
  async function run(operation: () => Promise<void>) {
    const expected = account;
    if (!expected || expected !== unlockedAccount()) return;
    try {
      await operation();
      if (expected !== unlockedAccount()) return;
      failures.current.write = false;
      const version = ++revision.current,
        rows = await dashboardPreferences.get();
      if (expected === unlockedAccount() && version === revision.current)
        setState({
          account: expected,
          rows,
          error: failures.current.migration,
        });
    } catch {
      if (expected === unlockedAccount()) {
        failures.current.write = true;
        revision.current++;
        setState((current) => ({
          account: expected,
          rows: current?.account === expected ? current.rows : [],
          error: true,
        }));
      }
    }
  }
  return {
    rows:
      account?.username === session.user.username && state?.account === account
        ? (state?.rows ?? [])
        : [],
    error: state?.account === account && state.error,
    pin: (value: DashboardPin) =>
      run(() =>
        dashboardPreferences.pin({
          path: value.path,
          title: value.title,
          visitedAt: value.visitedAt,
        }),
      ),
    unpin: (path: string) => run(() => dashboardPreferences.unpin(path)),
    move: (value: {
      path: string;
      target?: string;
      after?: boolean;
      offset?: number;
    }) => run(() => dashboardPreferences.move(value)),
  };
}
