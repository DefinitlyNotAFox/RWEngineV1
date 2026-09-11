export const playerAnalysisFixture = {
  search: [
    { playerId: 2400011, playerName: 'Aster', level: 88, factionId: 54199, source: 'RWEngine' },
    { playerId: 2400012, playerName: 'Asterion', level: 76, factionId: 44501, source: 'Torn' },
    { playerId: 2400013, playerName: 'AsterVale', level: 54, factionId: null, source: 'Torn' }
  ],
  analysis: {
    generatedAt: 1800000000,
    player: {
      playerId: 2400011,
      playerName: 'Aster',
      level: 88,
      rank: 'Distinguished',
      title: 'Reviver',
      ageDays: 4280,
      signedUpAt: 1430200000,
      gender: 'Male',
      factionId: 54199,
      lastActionAt: 1799998200,
      lastActionStatus: 'Online',
      statusState: 'Okay',
      statusUntil: null,
      revivable: true
    },
    context: {
      localHistoryAvailable: true,
      localFactionId: 54199,
      localFactionName: 'Example Faction',
      currentFactionMember: true,
      observedAt: 1799996400
    },
    battleStats: {
      value: 1450000000,
      source: 'FF Scouter',
      verified: false,
      observedAt: 1799827200,
      change30d: 107000000,
      changePct30d: 0.08
    },
    activity: {
      perDay30d: 23400,
      perDayPrevious30d: 21800,
      changePct: 0.073,
      coverageDays: 30
    },
    xanax: {
      perDay30d: 3.1,
      perDayPrevious30d: 2.8,
      changePct: 0.107,
      coverageDays: 30
    },
    war: {
      last4: {
        warsAvailable: 4,
        warsParticipated: 4,
        participation: 1,
        hits: 138,
        hitsPerWar: 34.5,
        assists: 7,
        scoreUp: 1180,
        scoreDown: 560,
        netScore: 620
      },
      history: [
        war('Rosarium',46535,38,3,230),
        war('Undead Havoc',46238,31,2,165),
        war('Soria Moria',45129,36,1,140),
        war('Tardis',44402,33,1,85),
        war('Purity',43307,25,0,40),
        war('Nocturne',42831,41,3,260)
      ]
    },
    history: {
      snapshots: [
        snap(-90,930000000,17400,2.1),
        snap(-75,1000000000,18600,2.3),
        snap(-60,1080000000,19400,2.5),
        snap(-45,1160000000,20500,2.7),
        snap(-30,1343000000,21800,2.8),
        snap(-15,1390000000,22600,2.9),
        snap(0,1450000000,23400,3.1)
      ]
    },
    sources: [
      { label:'Torn', detail:'Current public profile and status' },
      { label:'RWEngine', detail:'90 days of faction snapshots' },
      { label:'FF Scouter', detail:'Battle-stat estimate' }
    ]
  },
  external: {
    generatedAt: 1800000000,
    player: {
      playerId: 3000022,
      playerName: 'OutsidePlayer',
      level: 91,
      rank: 'Highly competent',
      title: 'Trader',
      ageDays: 5100,
      signedUpAt: 1360000000,
      gender: 'Female',
      factionId: 61234,
      lastActionAt: 1799992000,
      lastActionStatus: 'Idle',
      statusState: 'Okay',
      statusUntil: null,
      revivable: false
    },
    context: {
      localHistoryAvailable: false,
      localFactionId: null,
      localFactionName: null,
      currentFactionMember: false,
      observedAt: null
    },
    battleStats: { value:null,source:null,verified:false,observedAt:null,change30d:null,changePct30d:null },
    activity: { perDay30d:null,perDayPrevious30d:null,changePct:null,coverageDays:0 },
    xanax: { perDay30d:null,perDayPrevious30d:null,changePct:null,coverageDays:0 },
    war: { last4:null, history:[] },
    history: { snapshots:[] },
    sources: [{ label:'Torn', detail:'Current public profile and status' }]
  }
};

function snap(offsetDays,stats,activityHours,xanaxPerDay){
  return {
    at:1800000000+offsetDays*86400,
    battleStatsValue:stats,
    activityPerDaySeconds:activityHours,
    xanaxPerDay
  };
}

function war(opponent,warId,hits,assists,netScore){
  return { opponentFactionName:opponent,warId,hits,assists,outsideHits:0,netScore,endedAt:1800000000-(46535-warId)*86400/100 };
}
