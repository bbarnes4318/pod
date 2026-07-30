import { AppPage, Skeleton } from "@/components/studio";

export default function StudioLoading() {
  return <AppPage><div aria-busy="true" aria-label="Loading Studio page" className="studioLoading"><div className="studioLoadingHead"><Skeleton width={220} height={32} /><Skeleton width="min(680px, 100%)" height={18} /></div><div className="loadingMetricGrid">{Array.from({ length: 4 }).map((_, index) => <div className="loadingMetric" key={index}><Skeleton width={100} height={14} /><Skeleton width={72} height={30} /></div>)}</div><div className="loadingTable"><Skeleton height={40} />{Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} height={52} />)}</div></div></AppPage>;
}
