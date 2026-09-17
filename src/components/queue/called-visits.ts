"use client";
import {useEffect, useState} from "react";
import {useAuthSession} from "@/lib/auth/use-auth-session";
import {apiFetch} from "@/lib/auth/api-fetch";

export type CalledVisit = {id:string;plate:string;clientId:string;clientName:string;publicCode?:string;version:number};
type CalledVisitsPage = {enabled:boolean;mode?:"off"|"observe"|"enforce";items:CalledVisit[]};

/** The origin field consumes the list; selecting a visit never mutates its status. */
export function useCalledVisits(active:boolean) {
  const {checkinsEnabled}=useAuthSession();
  const [refresh, setRefresh]=useState(0);
  const [result, setResult]=useState<{key:number;data?:CalledVisitsPage;error?:string}|null>(null);
  const requesting=active&&checkinsEnabled;
  useEffect(()=>{
    if(!requesting) return;
    const controller=new AbortController();
    void apiFetch<CalledVisitsPage>("/api/checkins/called",{signal:controller.signal})
      .then(data=>{if(!controller.signal.aborted) setResult({key:refresh,data});})
      .catch(error=>{if(!controller.signal.aborted) setResult({key:refresh,error:error instanceof Error?error.message:"Não foi possível consultar as chamadas."});});
    return ()=>controller.abort();
  },[requesting,refresh]);
  const current=requesting&&result?.key===refresh?result:null;
  return {
    enabled:requesting&&current?.data?.enabled===true,
    mode:current?.data?.mode??"off",
    items:current?.data?.items??[],
    loading:requesting&&!current,
    error:requesting?current?.error??null:null,
    refresh:()=>setRefresh(value=>value+1)
  };
}
