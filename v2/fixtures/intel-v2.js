export const intelFixture = {
  generatedAt: 1800000000,
  faction: { factionId: 54199, factionName: 'Example Faction' },
  freshness: { state: 'fresh', observedAt: 1799996400, ageSeconds: 3600 },
  summary: {
    currentMembers: 12,
    knownBattleStats: 10,
    medianBattleStats: 785000000,
    avgActivityPerDay30d: 18720,
    avgXanaxPerDay30d: 2.43,
    avgOrganizedCrimesPerMonth: 6.2,
    avgParticipationLast4: 0.73,
    membersWithNotes: 2,
    membersNeedingAttention: 4
  },
  members: [
    member(101,'Aster','Leader',88,1450000000,0.98,23400,21800,3.1,2.8,4,4,34.5,620,[
      positive('battle_stats_growth','stats +8%','Battle stats increased by 8% over 30 days.'),
      positive('strong_war_output','war output +','Hits/war is 38% above the faction median with positive net score.')
    ], [820,835,851,870,895,930,970,1020], [4.8,5.1,5.3,5.4,5.8,6.0,6.3,6.5], [2.5,2.7,2.8,2.9,3.0,3.1,3.0,3.1]),
    member(102,'Bracken','Co-lead',82,1180000000,0.82,20100,19600,2.7,2.6,4,4,27.0,410,[], [700,718,735,751,770,792,810,826],[5.0,5.1,5.2,5.3,5.4,5.5,5.4,5.6],[2.4,2.5,2.6,2.6,2.7,2.7,2.8,2.7]),
    member(103,'Cinder','Member',74,760000000,0.55,10800,17600,1.8,2.7,4,2,12.5,95,[
      attention('activity_down','activity -39%','Activity/day is -39% versus the previous 30 days.'),
      attention('xanax_down','xanax -33%','Xanax/day is -33% versus the previous 30 days.'),
      attention('low_war_participation','2/4 wars','Participated in 2 of the last 4 wars.')
    ], [620,632,641,651,662,675,691,703],[6.2,5.9,5.5,5.0,4.5,4.0,3.5,3.0],[2.8,2.8,2.7,2.5,2.3,2.1,1.9,1.8]),
    member(104,'Drift','Member',69,null,0.18,7200,8100,1.1,1.3,4,1,4.0,-20,[
      attention('missing_battle_stats','stats missing','No current battle-stat estimate is available.'),
      attention('low_war_participation','1/4 wars','Participated in 1 of the last 4 wars.')
    ], [null,null,null,null,null,null,null,null],[2.4,2.3,2.2,2.2,2.1,2.0,2.1,2.0],[1.2,1.3,1.2,1.2,1.1,1.1,1.0,1.1]),
    member(105,'Ember','Member',66,680000000,0.76,25200,16400,3.0,2.2,4,4,31.0,500,[
      positive('activity_up','activity +54%','Activity/day is +54% versus the previous 30 days.'),
      positive('xanax_up','xanax +36%','Xanax/day is +36% versus the previous 30 days.')
    ], [510,528,545,561,579,601,625,650],[4.1,4.4,4.8,5.1,5.6,6.0,6.5,7.0],[2.0,2.1,2.2,2.3,2.5,2.7,2.9,3.0]),
    member(106,'Fallow','Member',63,590000000,0.48,14200,14900,2.2,2.3,4,3,18.0,140,[], [470,482,495,509,524,538,552,565],[4.0,4.1,4.0,4.0,3.9,4.0,4.1,3.9],[2.1,2.2,2.2,2.3,2.2,2.2,2.3,2.2]),
    member(107,'Gale','Member',61,540000000,0.91,19800,18500,2.6,2.4,4,4,22.5,230,[], [430,442,451,462,474,488,501,515],[4.7,4.9,5.0,5.1,5.3,5.4,5.5,5.5],[2.2,2.3,2.4,2.4,2.5,2.5,2.6,2.6]),
    member(108,'Hollow','Member',58,495000000,0.07,3600,7200,0.7,1.8,4,0,0,-55,[
      attention('inactive','inactive 4d','No action recorded for 4 days.'),
      attention('activity_down','activity -50%','Activity/day is -50% versus the previous 30 days.'),
      attention('low_war_participation','0/4 wars','Participated in 0 of the last 4 wars.')
    ], [410,421,433,445,457,468,479,489],[3.0,2.9,2.8,2.5,2.1,1.7,1.3,1.0],[1.8,1.7,1.6,1.4,1.2,1.0,0.8,0.7], 4),
    member(109,'Iris','Member',55,425000000,0.64,17100,16800,2.4,2.4,4,3,19.0,165,[], [330,342,354,366,379,391,405,418],[4.4,4.5,4.6,4.7,4.6,4.7,4.8,4.8],[2.3,2.4,2.4,2.4,2.5,2.4,2.4,2.4]),
    member(110,'Juniper','Member',52,310000000,0.43,15300,14100,2.1,1.8,4,3,17.0,110,[
      note('stale_battle_stats','stats stale','Battle-stat estimate was last observed 26 days ago.')
    ], [270,278,286,294,300,305,307,310],[3.5,3.7,3.9,4.0,4.1,4.2,4.2,4.3],[1.7,1.8,1.9,1.9,2.0,2.0,2.1,2.1]),
    member(111,'Kestrel','Member',49,180000000,0.71,12600,12900,1.7,1.8,4,3,15.5,80,[], [140,146,151,157,163,168,173,178],[3.4,3.5,3.5,3.6,3.6,3.5,3.6,3.5],[1.8,1.8,1.8,1.7,1.8,1.8,1.7,1.7]),
    member(112,'Lumen','Member',46,95000000,0.36,9300,9800,1.4,1.5,4,2,9.5,35,[
      attention('low_war_participation','2/4 wars','Participated in 2 of the last 4 wars.')
    ], [72,75,78,81,84,87,90,94],[2.9,2.8,2.8,2.7,2.7,2.6,2.6,2.6],[1.5,1.5,1.5,1.4,1.5,1.4,1.4,1.4]),
    member(113,'Morrow','Former',58,390000000,0.50,0,0,0,0,4,2,14.0,-40,[
      note('former_member','former','No longer in the faction.')
    ], [310,320,332,345,356,367,378,389],[3.8,3.9,4.0,3.7,3.2,2.6,1.2,0],[2.0,2.1,2.1,2.0,1.7,1.2,0.5,0],0,false)
  ]
};

function member(id,name,position,level,stats,lastActionRatio,activity,prevActivity,xanax,prevXanax,warsAvailable,warsParticipated,hitsPerWar,netScore,insights,statsSeries,activitySeries,xanaxSeries,inactiveDays=0,current=true){
  const now=intelFixtureTime();
  return {
    playerId:id, playerName:name, level, position, current, daysInFaction:240 + (id%7)*31,
    presence:{
      lastActionAt: now - (inactiveDays ? inactiveDays*86400 : Math.round((1-lastActionRatio)*7*3600)),
      lastActionStatus: inactiveDays ? 'Offline' : 'Online recently',
      statusState: inactiveDays ? 'Okay' : 'Okay',
      statusUntil:null
    },
    battleStats:{
      value:stats, source: stats===null ? null : 'FF Scouter', verified:false,
      observedAt: stats===null ? null : now - ((id===110?26:2)*86400),
      ageSeconds:stats===null?null:(id===110?26:2)*86400,
      change30d:stats===null?null:Math.round(stats*0.06),
      changePct30d:stats===null?null:0.06,
      trendReliable:stats!==null
    },
    activity:{perDay30d:activity,perDayPrevious30d:prevActivity,changePct:(activity-prevActivity)/prevActivity,coverageDays:30,previousCoverageDays:30},
    xanax:{perDay30d:xanax,perDayPrevious30d:prevXanax,changePct:(xanax-prevXanax)/prevXanax,coverageDays:30,previousCoverageDays:30},
    ocs:{total:6,perMonth:6.2,perMonthPrevious:5.1,perDay:6.2/30.44,perDayPrevious:5.1/30.44,changePct:(6.2-5.1)/5.1,coverageDays:30,previousCoverageDays:30},
    war:{
      last4:{warsAvailable,warsParticipated,participation:warsParticipated/warsAvailable,hits:Math.round(hitsPerWar*Math.max(warsParticipated,1)),hitsPerWar,assists:id%5,respectEarned:100+id%13*20,respectLost:id%4*15,scoreUp:Math.max(netScore,0)+120,scoreDown:Math.max(-netScore,0)+120,netScore},
      previous4:{warsAvailable:4,warsParticipated:Math.min(4,warsParticipated+(id%3===0?1:0)),participation:Math.min(4,warsParticipated+(id%3===0?1:0))/4,hits:0,hitsPerWar:Math.max(0,hitsPerWar-(id%2?2:-2)),netScore:netScore-20}
    },
    coverage:{snapshotDays60d:60,battleStatsKnown:stats!==null,warHistoryAvailable:8},
    notes:fixtureNotes(id),
    insights,
    history:{
      stats: series(statsSeries,'stats'),
      activity: series(activitySeries.map(v=>v*3600),'activity'),
      xanax: series(xanaxSeries,'xanax'),
      ocs: series([4.1,4.5,4.8,5.0,5.2,5.6,5.9,6.2],'ocs'),
      wars:[
        war('Rosarium',46535,4,Math.round(hitsPerWar+4),id%4,netScore+80),
        war('Undead Havoc',46238,3,Math.round(hitsPerWar-2),id%3,netScore+30),
        war('Soria Moria',45129,2,Math.round(hitsPerWar+1),id%2,netScore-10),
        war('Tardis',44402,1,Math.max(0,Math.round(hitsPerWar-6)),0,netScore-45),
        war('Purity',43307,0,Math.max(0,Math.round(hitsPerWar-10)),0,netScore-60),
        war('Nocturne',42831,6,Math.round(hitsPerWar+6),2,netScore+95),
        war('Atlas',42482,5,Math.round(hitsPerWar+2),1,netScore+25),
        war('Nova',41757,4,Math.round(hitsPerWar),1,netScore)
      ]
    }
  };
}

function series(values,type){
  const now=intelFixtureTime();
  return values.map((value,index)=>({at:now-(values.length-1-index)*10*86400,value,type}));
}
function war(opponent,warId,assists,hits,outside,netScore){return {opponent,warId,endedAt:intelFixtureTime()-warId%12*86400,hits,assists,outsideHits:outside,netScore};}
function attention(code,label,text){return {code,kind:'attention',label,text};}
function positive(code,label,text){return {code,kind:'positive',label,text};}
function note(code,label,text){return {code,kind:'note',label,text};}
function fixtureNotes(id){
  if(id===103) return {text:'Check availability before the next ranked war.',hasText:true,tags:['Watch','RW'],updatedAt:intelFixtureTime()-7200,updatedBy:{playerId:101,playerName:'Aster'}};
  if(id===108) return {text:'',hasText:false,tags:['Inactive'],updatedAt:intelFixtureTime()-86400,updatedBy:{playerId:101,playerName:'Aster'}};
  return {text:'',hasText:false,tags:[],updatedAt:null,updatedBy:null};
}
function intelFixtureTime(){return 1800000000;}
