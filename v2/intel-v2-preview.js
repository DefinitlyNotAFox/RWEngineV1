import {
  formatNumber, formatCompact, formatDecimal, formatPercent,
  formatDuration, formatRelative, formatDate, escapeHtml, metric
} from './core.js';
import { intelFixture } from './fixtures/intel-v2.js';

let data = intelFixture;
const liveMode = new URL(location.href).searchParams.get('live') === '1';

const filters = [
  ['all','All'],
  ['attention','Needs attention'],
  ['inactive','Inactive 48h+'],
  ['war','Low participation'],
  ['decline','Declining'],
  ['stats','Stats missing/stale'],
  ['former','Former members']
];

const priority = [
  'inactive',
  'low_war_participation',
  'participation_down',
  'activity_down',
  'xanax_down',
  'strong_war_output',
  'activity_up',
  'xanax_up',
  'battle_stats_growth',
  'missing_battle_stats',
  'stale_battle_stats'
];

let activeFilter='all';
let selectedId=null;
let sortKey='attention';
let sortDirection='desc';
let trendDays=90;
const detailCache=new Map();
const detailLoading=new Set();

init();

async function init(){
  if (liveMode) {
    try {
      data = await loadLiveIntel();
      document.querySelector('.preview-flag').textContent = 'Live preview';
      document.querySelector('.context-button').textContent = 'Live Intel 2.0 · staged endpoint';
    } catch (error) {
      document.querySelector('.preview-flag').textContent = 'Live failed';
      document.querySelector('.context-button').textContent = 'Falling back to fixture data';
      console.error(error);
      data = intelFixture;
    }
  }
  document.querySelector('#intel2Freshness').textContent = liveMode
    ? `Live data · snapshots updated ${formatRelative(data.freshness?.observedAt || data.generatedAt)}`
    : `Fixture contract · generated ${formatRelative(data.generatedAt)} relative to preview clock`;

  document.querySelector('#intel2Filters').innerHTML = filters.map(([key,label]) =>
    `<button class="intel2-filter${key===activeFilter?' active':''}" type="button" data-filter="${key}">${label}</button>`
  ).join('');

  document.querySelector('#intel2Filters').addEventListener('click', event=>{
    const button=event.target.closest('[data-filter]');
    if(!button)return;
    activeFilter=button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(item=>item.classList.toggle('active',item.dataset.filter===activeFilter));
    render();
  });

  document.querySelector('#intel2Search').addEventListener('input',render);

  document.querySelector('.intel2-table thead').addEventListener('click',event=>{
    const th=event.target.closest('th');
    if(!th)return;
    const map=['member','lastAction','stats','activity','xanax','participation','hits','attention'];
    const index=[...th.parentElement.children].indexOf(th);
    const key=map[index];
    if(!key)return;
    if(sortKey===key)sortDirection=sortDirection==='desc'?'asc':'desc';
    else{
      sortKey=key;
      sortDirection=key==='member'?'asc':'desc';
    }
    render();
  });

  document.querySelector('#intel2Body').addEventListener('click',async event=>{
    const trendButton=event.target.closest('[data-trend-days]');
    if(trendButton){
      trendDays=Number(trendButton.dataset.trendDays)||90;
      render();
      return;
    }
    if(event.target.closest('a'))return;
    const row=event.target.closest('tr[data-member-id]');
    if(!row)return;
    const id=Number(row.dataset.memberId);
    if(selectedId===id){
      selectedId=null;
      render();
      return;
    }

    selectedId=id;
    render();

    if(liveMode&&!detailCache.has(id)&&!detailLoading.has(id)){
      detailLoading.add(id);
      render();
      try{
        const payload=await loadLiveMember(id);
        detailCache.set(id,payload);
        const index=data.members.findIndex(member=>Number(member.playerId)===id);
        if(index>=0){
          data.members[index]={
            ...data.members[index],
            ...payload.member,
            history:payload.history||data.members[index].history||{stats:[],activity:[],xanax:[],wars:[]}
          };
        }
      }catch(error){
        detailCache.set(id,{error:error.message||'Failed to load member detail.'});
      }finally{
        detailLoading.delete(id);
        if(selectedId===id)render();
      }
    }
  });

  renderSummary();
  render();
}

async function loadLiveIntel(){
  const params=new URL(location.href).searchParams;
  const factionId=Number(params.get('factionId')||0);
  const response=await fetch('/v2/intel-v2',{
    method:'POST',
    credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'overview',
      ...(factionId>0?{factionId}:{})
    })
  });

  let payload;
  try{payload=await response.json();}
  catch(_){throw new Error('Intel 2.0 returned no JSON.');}

  if(!response.ok||payload?.success===false){
    throw new Error(payload?.message||`Intel 2.0 failed with HTTP ${response.status}.`);
  }

  return normalizeLivePayload(payload);
}

function normalizeLivePayload(payload){
  return {
    ...payload,
    members:(payload.members||[]).map(member=>({
      ...member,
      history:member.history||{
        stats:[],
        activity:[],
        xanax:[],
        wars:[]
      }
    }))
  };
}

async function loadLiveMember(playerId){
  const params=new URL(location.href).searchParams;
  const factionId=Number(params.get('factionId')||0);
  const response=await fetch('/v2/intel-v2',{
    method:'POST',
    credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'member',
      playerId,
      ...(factionId>0?{factionId}:{})
    })
  });

  let payload;
  try{payload=await response.json();}
  catch(_){throw new Error('Intel member detail returned no JSON.');}

  if(!response.ok||payload?.success===false){
    throw new Error(payload?.message||`Member detail failed with HTTP ${response.status}.`);
  }

  const history=payload.history||{};
  const snapshots=Array.isArray(history.snapshots)?history.snapshots:[];
  return {
    ...payload,
    history:{
      stats:snapshots
        .filter(point=>Number.isFinite(Number(point.battleStatsValue)))
        .map(point=>({at:point.at,value:Number(point.battleStatsValue)})),
      activity:deriveRateSeries(snapshots,'activityTotalSeconds'),
      xanax:deriveRateSeries(snapshots,'xanaxTakenTotal'),
      wars:Array.isArray(history.wars)?history.wars.map(war=>({
        opponent:war.opponentFactionName||'Unknown opponent',
        warId:war.warId,
        endedAt:war.endedAt,
        hits:Number(war.hits||0),
        assists:Number(war.assists||0),
        outsideHits:Number(war.outsideHits||0),
        netScore:Number(war.netScore||0)
      })):[]
    }
  };
}

function deriveRateSeries(snapshots,key){
  const rows=snapshots
    .filter(point=>Number.isFinite(Number(point.at))&&Number.isFinite(Number(point[key])))
    .sort((a,b)=>Number(a.at)-Number(b.at));

  const maxPerDay = key === 'activityTotalSeconds'
    ? 86400
    : key === 'xanaxTakenTotal'
      ? 10
      : Infinity;

  const series=[];
  for(let index=1;index<rows.length;index++){
    const previous=rows[index-1];
    const current=rows[index];
    const elapsed=(Number(current.at)-Number(previous.at))/86400;
    const delta=Number(current[key])-Number(previous[key]);
    const perDay=elapsed>0?delta/elapsed:null;

    if(
      elapsed>=0.5 &&
      delta>=0 &&
      Number.isFinite(perDay) &&
      perDay<=maxPerDay
    ){
      series.push({at:Number(current.at),value:perDay});
    }
  }
  return series;
}

function renderSummary(){
  const summary=document.querySelector('#intel2Summary');
  summary.innerHTML=[
    metric('Members',formatNumber(data.summary.currentMembers)),
    metric('Median stats',formatCompact(data.summary.medianBattleStats),`${data.summary.knownBattleStats} known`),
    metric('Activity / day',formatDuration(data.summary.avgActivityPerDay30d),'30d average'),
    metric('Xanax / day',formatDecimal(data.summary.avgXanaxPerDay30d,2),'30d average'),
    metric('RW participation',formatPercent(data.summary.avgParticipationLast4),'last 4 wars'),
    metric('Attention',formatNumber(data.summary.membersNeedingAttention),'members')
  ].join('');
}

function render(){
  const query=String(document.querySelector('#intel2Search').value||'').trim().toLowerCase();
  const rows=data.members
    .filter(member=>matchesFilter(member))
    .filter(member=>!query||member.playerName.toLowerCase().includes(query)||String(member.playerId).includes(query))
    .sort(compare);

  const body=document.querySelector('#intel2Body');
  body.innerHTML=rows.length?rows.map(member=>{
    const signal=topSignal(member);
    const selected=selectedId===member.playerId;
    return `
      <tr class="clickable${selected?' selected':''}" data-member-id="${member.playerId}">
        <td><span class="member-name">${escapeHtml(member.playerName)}</span><span class="member-meta">${escapeHtml(member.position)} · Lv ${member.level} · [${member.playerId}]</span></td>
        <td>${formatRelativeFromFixture(member.presence.lastActionAt)}<span class="member-meta">${escapeHtml(member.presence.lastActionStatus||'')}</span></td>
        <td>${member.battleStats.value==null?'—':formatCompact(member.battleStats.value)}<span class="trend ${trendClass(member.battleStats.changePct30d)}">${member.battleStats.value==null?'No estimate':trendLabel(member.battleStats.changePct30d,'30d')}</span></td>
        <td>${formatDuration(member.activity.perDay30d)}<span class="trend ${trendClass(member.activity.changePct)}">${trendLabel(member.activity.changePct,'vs prev 30d')}</span></td>
        <td>${formatDecimal(member.xanax.perDay30d,2)}<span class="trend ${trendClass(member.xanax.changePct)}">${trendLabel(member.xanax.changePct,'vs prev 30d')}</span></td>
        <td>${formatPercent(member.war.last4.participation)}<span class="member-meta">${member.war.last4.warsParticipated}/${member.war.last4.warsAvailable} wars</span></td>
        <td>${formatDecimal(member.war.last4.hitsPerWar,1)}</td>
        <td>${signal?`<span class="signal ${signal.kind}">${escapeHtml(signalLabel(signal,member))}</span>`:'—'}</td>
      </tr>
      ${selected?detailRow(member):''}
    `;
  }).join(''):'<tr class="empty-row"><td colspan="8">No members match this view.</td></tr>';
}

function matchesFilter(member){
  const insights=Array.isArray(member.insights)?member.insights:[];
  const codes=new Set(insights.map(item=>item.code));

  if(activeFilter==='all')return member.current!==false;
  if(activeFilter==='attention')return member.current!==false&&insights.some(item=>item.kind==='attention');
  if(activeFilter==='inactive')return member.current!==false&&codes.has('inactive');
  if(activeFilter==='war')return member.current!==false&&(codes.has('low_war_participation')||codes.has('participation_down'));
  if(activeFilter==='decline')return member.current!==false&&(codes.has('activity_down')||codes.has('xanax_down')||codes.has('participation_down'));
  if(activeFilter==='stats')return member.current!==false&&(codes.has('missing_battle_stats')||codes.has('stale_battle_stats'));
  if(activeFilter==='former')return member.current===false;
  return true;
}

function compare(a,b){
  const direction=sortDirection==='asc'?1:-1;
  const av=sortValue(a,sortKey);
  const bv=sortValue(b,sortKey);
  if(typeof av==='string'||typeof bv==='string')return String(av).localeCompare(String(bv))*direction;
  if(av==null&&bv==null)return a.playerName.localeCompare(b.playerName);
  if(av==null)return 1;
  if(bv==null)return -1;
  return ((av-bv)*direction)||a.playerName.localeCompare(b.playerName);
}

function sortValue(member,key){
  if(key==='member')return member.playerName;
  if(key==='lastAction')return member.presence.lastActionAt;
  if(key==='stats')return member.battleStats.value;
  if(key==='activity')return member.activity.perDay30d;
  if(key==='xanax')return member.xanax.perDay30d;
  if(key==='participation')return member.war.last4.participation;
  if(key==='hits')return member.war.last4.hitsPerWar;
  if(key==='attention'){
    const signal=topSignal(member);
    return signal?priority.length-priority.indexOf(signal.code):0;
  }
  return 0;
}

function topSignal(member){
  if(!member.insights.length)return null;
  return [...member.insights].sort((a,b)=>{
    const ai=priority.indexOf(a.code), bi=priority.indexOf(b.code);
    return (ai<0?999:ai)-(bi<0?999:bi);
  })[0];
}

function signalLabel(signal,member){
  if(signal?.label)return signal.label;
  if(signal?.code==='inactive'){
    const days=Math.max(1,Math.floor(Number(signal.value||0)/86400));
    return `inactive ${days}d`;
  }
  if(signal?.code==='low_war_participation'){
    return `${member.war?.last4?.warsParticipated??0}/${member.war?.last4?.warsAvailable??0} wars`;
  }
  if(signal?.code==='participation_down')return 'participation ↓';
  if(signal?.code==='activity_down'||signal?.code==='activity_up')return `activity ${signedPct(member.activity?.changePct)}`;
  if(signal?.code==='xanax_down'||signal?.code==='xanax_up')return `xanax ${signedPct(member.xanax?.changePct)}`;
  if(signal?.code==='strong_war_output')return 'war output +';
  if(signal?.code==='battle_stats_growth')return `stats ${signedPct(member.battleStats?.changePct30d)}`;
  if(signal?.code==='missing_battle_stats')return 'stats missing';
  if(signal?.code==='stale_battle_stats')return 'stats stale';
  return String(signal?.code||'').replaceAll('_',' ');
}

function signedPct(value){
  const number=Number(value);
  if(!Number.isFinite(number))return '—';
  const pct=Math.round(number*100);
  return `${pct>0?'+':''}${pct}%`;
}

function detailRow(member){
  const cached=detailCache.get(Number(member.playerId));
  if(liveMode&&detailLoading.has(Number(member.playerId))){
    return `<tr class="intel2-detail-row"><td colspan="8"><section class="intel2-detail"><p class="status-line">Loading member history…</p></section></td></tr>`;
  }
  if(liveMode&&cached?.error){
    return `<tr class="intel2-detail-row"><td colspan="8"><section class="intel2-detail"><p class="status-line error">${escapeHtml(cached.error)}</p></section></td></tr>`;
  }

  return `
    <tr class="intel2-detail-row">
      <td colspan="8">
        <section class="intel2-detail">
          <header class="intel2-detail-head">
            <div><h2>${escapeHtml(member.playerName)}</h2><p>${escapeHtml(member.position)} · Lv ${member.level} · ${member.current ? `${member.daysInFaction} days in faction` : 'former member'}</p></div>
            <a href="https://www.torn.com/profiles.php?XID=${member.playerId}" target="_blank" rel="noopener noreferrer">Torn profile ↗</a>
          </header>

          <div class="detail-metrics">
            ${metric('Battle stats',member.battleStats.value==null?'—':formatCompact(member.battleStats.value),member.battleStats.source||'Unavailable')}
            ${metric('Activity / day',formatDuration(member.activity.perDay30d),'30d')}
            ${metric('Xanax / day',formatDecimal(member.xanax.perDay30d,2),'30d')}
            ${metric('RW participation',formatPercent(member.war.last4.participation),'last 4')}
            ${metric('Hits / war',formatDecimal(member.war.last4.hitsPerWar,1),'last 4')}
            ${metric('Net score',formatSignedLocal(member.war.last4.netScore),'last 4')}
          </div>

          <div class="intel2-insights">
            ${member.insights.length?member.insights.map(item=>`<div class="intel2-insight ${item.kind}"><b>${escapeHtml(item.label||item.code.replaceAll('_',' '))}</b><span>${escapeHtml(item.text)}</span></div>`).join(''):'<div class="intel2-insight note"><b>No signals</b><span>No current attention signals for this member.</span></div>'}
          </div>

          <div class="intel2-trend-toolbar">
            <span>Trend window</span>
            <div>
              ${[30,60,90].map(days=>`<button type="button" data-trend-days="${days}" class="${trendDays===days?'active':''}">${days}d</button>`).join('')}
            </div>
          </div>

          <div class="intel2-trends">
            ${trendBlock('Battle stats',member.history.stats,value=>value==null?'—':formatCompact(value))}
            ${trendBlock('Activity / day',member.history.activity,formatDuration)}
            ${trendBlock('Xanax / day',member.history.xanax,value=>formatDecimal(value,2))}
          </div>

          <div class="intel2-wars">
            <header>Recent wars · ${member.history.wars.length} available</header>
            ${member.history.wars.map(war=>`
              <div class="intel2-war">
                <div><strong>${escapeHtml(war.opponent)}</strong><small>#${war.warId}</small></div>
                <span>${war.hits} hits</span>
                <span>${war.assists} assists</span>
                <span>${war.outsideHits} outside</span>
                <span>${formatSignedLocal(war.netScore)} net</span>
              </div>
            `).join('')}
          </div>

          <footer class="intel2-coverage">
            <span>Coverage</span>
            <b>${formatDecimal(member.coverage.snapshotDays60d,0)} snapshot days</b>
            <b>${member.coverage.warHistoryAvailable} wars available</b>
            <b>${member.coverage.battleStatsKnown?'battle stats known':'battle stats unavailable'}</b>
          </footer>
        </section>
      </td>
    </tr>
  `;
}

function trendBlock(title,series,formatter){
  const filtered=filterSeries(series,trendDays);
  const valid=filtered.filter(point=>Number.isFinite(Number(point.value)));
  const latest=valid.length?valid[valid.length-1].value:null;
  const availableDays=valid.length>1
    ? Math.max(1,Math.round((Number(valid[valid.length-1].at)-Number(valid[0].at))/86400))
    : 0;
  const windowLabel=availableDays>0&&availableDays<trendDays
    ? `${availableDays}d available`
    : `${trendDays}d`;
  return `<section class="intel2-trend"><header><strong>${title}</strong><span>${windowLabel} · ${formatter(latest)}</span></header>${sparkline(filtered)}</section>`;
}

function filterSeries(series,days){
  if(!series.length)return [];
  const newest=Math.max(...series.map(point=>Number(point.at)||0));
  const cutoff=newest-days*86400;
  return series.filter(point=>(Number(point.at)||0)>=cutoff);
}

function sparkline(series){
  const valid=series.map((point,index)=>({index,value:Number(point.value)})).filter(point=>Number.isFinite(point.value));
  if(valid.length<2)return '<div class="sparkline"></div>';
  const min=Math.min(...valid.map(point=>point.value));
  const max=Math.max(...valid.map(point=>point.value));
  const spread=max-min||1;
  const points=valid.map(point=>{
    const x=(point.index/(series.length-1))*100;
    const y=48-((point.value-min)/spread)*42;
    return [x,y];
  });
  const d=points.map(([x,y],index)=>index===0?`M ${x.toFixed(2)} ${y.toFixed(2)}`:`L ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 100 54" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="50" x2="100" y2="50"></line><path d="${d}"></path></svg>`;
}

function trendLabel(value,suffix){
  const number=Number(value);
  if(!Number.isFinite(number))return 'No comparison';
  const pct=Math.round(number*100);
  return `${pct>0?'+':''}${pct}% ${suffix}`;
}

function trendClass(value){
  const number=Number(value);
  if(!Number.isFinite(number)||Math.abs(number)<0.1)return '';
  return number>0?'up':'down';
}

function formatRelativeFromFixture(timestamp){
  if(!timestamp)return '—';
  const delta=Math.max(0,data.generatedAt-Number(timestamp));
  if(delta<60)return `${delta}s`;
  if(delta<3600)return `${Math.floor(delta/60)}m`;
  if(delta<86400)return `${Math.floor(delta/3600)}h`;
  return `${Math.floor(delta/86400)}d`;
}

function formatSignedLocal(value){
  const number=Number(value||0);
  const formatted=formatDecimal(number,2);
  return number>0?`+${formatted}`:formatted;
}
