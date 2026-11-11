import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Loading } from "@sortsys/react-components";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { archiveLegacyData } from "~/lib/crypto/migration";
import type { MigrationProgress } from "~/lib/crypto/migration";
import { uiText } from "~/lib/i18n";
import { AuthLayout } from "./AuthLayout";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";

export function TenantMigration() {
  const session=useSessionInfo();
  const [progress,setProgress]=useState<MigrationProgress|null>(null);
  const [phase,setPhase]=useState<"preparing"|"checking"|"pending"|"failed">("preparing");
  const [attempt,setAttempt]=useState(0);
  const serial=useRef<Promise<void>>(Promise.resolve());
  useEffect(()=>{
    const controller=new AbortController();
    const subject=`user:${session.user.id}`;
    // Serialize retries and React's remount checks. Confirmed source parts are
    // reused; navigation never starts a second overlapping copy in this view.
    serial.current=serial.current.catch(()=>undefined).then(async()=>{
      if(controller.signal.aborted) return;
      setPhase("preparing");
      try {
        await archiveLegacyData(client,subject,value=>{if(!controller.signal.aborted)setProgress(value);},controller.signal);
        if(controller.signal.aborted) return;
        setPhase("checking");
        const {openArchivedDatabase}=await import("~/lib/data/bootstrap");
        const opened=await openArchivedDatabase(client,subject,controller.signal);
        try {
          const {prepareOrganization}=await import("~/lib/data/migrateOrganization");
          await prepareOrganization(client,opened.database,subject,controller.signal);
          const {preparePreferences}=await import("~/lib/data/migratePreferences");
          await preparePreferences(client,opened.database,subject,controller.signal);
          const {preparePrintTemplates}=await import("~/lib/data/migratePrintTemplates");
          await preparePrintTemplates(client,opened.database,subject,controller.signal);
          const {prepareProductCatalog}=await import("~/lib/data/migrateProducts");
          await prepareProductCatalog(client,opened.database,subject,controller.signal);
          const {prepareVendors}=await import("~/lib/data/migrateVendors");
          await prepareVendors(client,opened.database,subject,controller.signal);
          const {prepareAddressBook}=await import("~/lib/data/migrateAddressBook");
          await prepareAddressBook(client,opened.database,subject,controller.signal);
          const {prepareProjects}=await import("~/lib/data/migrateProjects");
          await prepareProjects(client,opened.database,subject,controller.signal);
          const {prepareTools}=await import("~/lib/data/migrateTools");
          await prepareTools(client,opened.database,subject,controller.signal);
          const {prepareDeliveryNotes}=await import("~/lib/data/migrateDeliveryNotes");
          await prepareDeliveryNotes(client,opened.database,subject,controller.signal);
          const {prepareProjectFiles}=await import("~/lib/data/migrateProjectFiles");
          await prepareProjectFiles(client,opened.database,subject,controller.signal);
          const {prepareCommercialCases}=await import("~/lib/data/migrateCommercial");
          await prepareCommercialCases(client,opened.database,subject,controller.signal);
          const {prepareCommercialDocuments}=await import("~/lib/data/migrateCommercialDocuments");
          await prepareCommercialDocuments(client,opened.database,controller.signal);
          const {preparePrivateLlm}=await import("~/lib/data/privateLlm");
          await preparePrivateLlm(client,subject,controller.signal);
        } finally {await opened.database.close();}
        if(!controller.signal.aborted)setPhase("pending");
      } catch {if(!controller.signal.aborted)setPhase("failed");}
    });
    return()=>controller.abort();
  },[session.user.id,attempt]);
  const percent=progress?.total ? Number(progress.done*1000n/progress.total)/10 : 0;
  return <AuthLayout title={uiText("Arbeitsbereich vorbereiten","Preparing workspace")}>
    {phase==="failed" ? <>
      <MyCallout color="red">{uiText("Die Vorbereitung wurde unterbrochen. Bereits abgeschlossene Schritte bleiben erhalten.","Preparation was interrupted. Completed steps are retained.")}</MyCallout>
      <MyButton onClick={()=>setAttempt(value=>value+1)}>{uiText("Erneut versuchen","Retry")}</MyButton>
    </> : phase==="pending" ? <p>{uiText("Die Vorbereitung ist noch nicht vollständig abgeschlossen.","Workspace preparation is not yet complete.")}</p> : <>
      <Loading active description={phase==="checking" ? uiText("Daten werden geprüft …","Checking data…") : uiText("Arbeitsbereich wird vorbereitet …","Preparing workspace…")} />
      {progress && phase==="preparing" && <progress className="w-full" max={100} value={percent} aria-label={uiText("Fortschritt","Progress")} />}
    </>}
    <Link to="/auth/recovery">{uiText("Organisation wiederherstellen","Recover organization")}</Link>
    <MyButton kind="tertiary" onClick={()=>client.logout()}>{uiText("Abmelden","Sign out")}</MyButton>
  </AuthLayout>;
}
