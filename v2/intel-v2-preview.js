import {
  formatNumber, formatCompact, formatDecimal, formatPercent,
  formatDuration, formatRelative, formatDate, escapeHtml, metric
} from './core.js';
import { intelFixture as data } from './fixtures/intel-v2.js';

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
  'missing_battle_stats',
  'stale_battle_stats',
  'strong_war_output',
  'activity_up',
  'xanax_up',
  'battle_stats_growth'
];

let activeFilter='all';
let selectedId=null;
let sortKey='attention';
let sortDirection='desc';
let trendDays=90;

init();

function init(){
  document.querySelector('#intel2Freshness').textContent =
    `Fixture contract · generated ${formatRelative(data.generatedAt)} relative to preview clock`;

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

  document.querySelector('#intel2Body').addEventListener('click',event=>{
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
    selectedId=selectedId===id?null:id;
    render();
  });

  renderSummary();
  render();
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
        <td>${signal?`<span class="signal ${signal.kind}">${escapeHtml(signal.label||signal.code)}</span>`:'—'}</td>
      </tr>
      ${selected?detailRow(member):''}
    `;
  }).join(''):'<tr class="empty-row"><td colspan="8">No members match this view.</td></tr>';
}

function matchesFilter(member){
  if(activeFilter==='all')return true;
  const codes=new Set(member.insights.map(item=>item.code));
  if(activeFilter==='attention')return member.insights.some(item=>item.kind==='attention');
  if(activeFilter==='inactive')return codes.has('inactive');
  if(activeFilter==='war')return codes.has('low_war_participation')||codes.has('participation_down');
  if(activeFilter==='decline')return codes.has('activity_down')||codes.has('xanax_down')||codes.has('participation_down');
  if(activeFilter==='stats')return codes.has('missing_battle_stats')||codes.has('stale_battle_stats');
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

function detailRow(member){
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
            <header>Last 8 wars</header>
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
  return `<section class="intel2-trend"><header><strong>${title}</strong><span>${trendDays}d · ${formatter(latest)}</span></header>${sparkline(filtered)}</section>`;
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
  const d=points.map(([x,y],index)=>index===0?`M ${x.toFixed(2)} ${y.toFixed(2)}`:`L ${x.toFixed(2)} ${y.toFixed(2)}`)).join(' ');
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
