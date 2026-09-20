const DAY = 86400;

export const DEFAULT_AUTO_TAG_SETTINGS = {
  lowWarHits:{ enabled:true, yellow:15, orange:10, red:6 },
  highWarHits:{ enabled:true, green:25, bright:60 },
  outsideHits:{ enabled:true, yellow:10 },
  respectPerHit:{ enabled:true, yellow:4.5, orange:4, red:3.5, minimumHits:10 },
  assists:{ enabled:true, green:10, bright:35 },
  trainingEnergy:{ enabled:true, red:400, orange:550, yellow:700, green:1200, bright:1500 },
  inactivity:{ enabled:true, yellowHours:24, orangeHours:48, redHours:72 }
};

const CATEGORY_PRIORITY = {
  inactivity:60,
  war_hits:50,
  respect:40,
  assists:30,
  outside_hits:20,
  training:10
};

export function buildAutoTags(member, performance = null, settings = null, now = Math.floor(Date.now() / 1000)) {
  const config = mergedSettings(settings);
  const tags = [];

  addInactivity(tags, member, config.inactivity, now);
  addWarTags(tags, performance, config);
  addTraining(tags, member, config.trainingEnergy);

  return tags.sort(compareTags);
}

function addInactivity(tags, member, config, now) {
  if (!config.enabled || member?.current === false) return;

  const lastActionAt = numberOrNull(member?.presence?.lastActionAt);
  if (lastActionAt === null) return;

  const hours = Math.max(0, Number(now || 0) - lastActionAt) / 3600;
  let tier = null;
  if (hours >= config.redHours) tier = 'red';
  else if (hours >= config.orangeHours) tier = 'orange';
  else if (hours >= config.yellowHours) tier = 'yellow';
  if (!tier) return;

  const roundedHours = Math.floor(hours);
  tags.push(makeTag({
    code:'auto_inactive',
    kind:'attention',
    tier,
    category:'inactivity',
    title:tier === 'red' ? 'Inactive 72h+' : tier === 'orange' ? 'Inactive 48h+' : 'Inactive 24h+',
    text:`Last action ${formatElapsedHours(roundedHours)} ago.`,
    value:hours
  }));
}

function addWarTags(tags, performance, config) {
  const wars = numberOrNull(performance?.wars);
  if (!(wars > 0)) return;

  const hits = numberOrNull(performance?.warHits) ?? 0;
  const hitsPerWar = numberOrNull(performance?.avgHitsPerWar) ?? (hits / wars);

  if (config.lowWarHits.enabled) {
    let tier = null;
    if (hitsPerWar < config.lowWarHits.red) tier = 'red';
    else if (hitsPerWar < config.lowWarHits.orange) tier = 'orange';
    else if (hitsPerWar < config.lowWarHits.yellow) tier = 'yellow';

    if (tier) {
      tags.push(makeTag({
        code:'auto_low_war_hits',
        kind:'attention',
        tier,
        category:'war_hits',
        title:tier === 'red' ? 'Critical war hits' : tier === 'orange' ? 'Very low war hits' : 'Low war hits',
        text:`${formatRate(hitsPerWar, 1)} hits / war.`,
        value:hitsPerWar
      }));
    }
  }

  if (config.highWarHits.enabled) {
    let tier = null;
    if (hitsPerWar >= config.highWarHits.bright) tier = 'bright';
    else if (hitsPerWar >= config.highWarHits.green) tier = 'green';

    if (tier) {
      tags.push(makeTag({
        code:'auto_high_war_hits',
        kind:'positive',
        tier,
        category:'war_hits',
        title:tier === 'bright' ? 'Exceptional war hits' : 'High war hits',
        text:`${formatRate(hitsPerWar, 1)} hits / eligible war.`,
        value:hitsPerWar
      }));
    }
  }

  if (config.outsideHits.enabled) {
    const outsideHits = numberOrNull(performance?.outsideHits);
    if (outsideHits !== null) {
      const outsidePerWar = outsideHits / wars;
      if (outsidePerWar >= config.outsideHits.yellow) {
        tags.push(makeTag({
          code:'auto_outside_hits',
          kind:'attention',
          tier:'yellow',
          category:'outside_hits',
          title:'High outside hits',
          text:`${formatRate(outsidePerWar, 1)} outside hits / war.`,
          value:outsidePerWar
        }));
      }
    }
  }

  if (config.assists.enabled) {
    const assists = numberOrNull(performance?.assists);
    if (assists !== null) {
      const assistsPerWar = assists / wars;
      let tier = null;
      if (assistsPerWar >= config.assists.bright) tier = 'bright';
      else if (assistsPerWar >= config.assists.green) tier = 'green';

      if (tier) {
        tags.push(makeTag({
          code:'auto_assists',
          kind:'positive',
          tier,
          category:'assists',
          title:tier === 'bright' ? 'Exceptional assists' : 'High assists',
          text:`${formatRate(assistsPerWar, 1)} assists / war.`,
          value:assistsPerWar
        }));
      }
    }
  }

  if (config.respectPerHit.enabled) {
    const respectEarned = numberOrNull(performance?.respectEarned);
    const detailWars = numberOrNull(performance?.attackDetailWars);
    const completeDetailCoverage = detailWars === null || detailWars >= wars;

    if (
      respectEarned !== null &&
      hits >= config.respectPerHit.minimumHits &&
      completeDetailCoverage
    ) {
      const respectPerHit = hits > 0 ? respectEarned / hits : null;
      if (respectPerHit !== null) {
        let tier = null;
        if (respectPerHit < config.respectPerHit.red) tier = 'red';
        else if (respectPerHit < config.respectPerHit.orange) tier = 'orange';
        else if (respectPerHit < config.respectPerHit.yellow) tier = 'yellow';

        if (tier) {
          tags.push(makeTag({
            code:'auto_low_respect_per_hit',
            kind:'attention',
            tier,
            category:'respect',
            title:tier === 'red' ? 'Critical respect / hit' : tier === 'orange' ? 'Very low respect / hit' : 'Low respect / hit',
            text:`${formatRate(respectPerHit, 2)} respect / hit.`,
            value:respectPerHit
          }));
        }
      }
    }
  }
}

function addTraining(tags, member, config) {
  if (!config.enabled) return;
  const rate = trainingEnergyPerDay(member);
  if (rate === null) return;

  let kind = null;
  let tier = null;
  let title = '';

  if (rate < config.red) {
    kind = 'attention'; tier = 'red'; title = 'Critical training';
  } else if (rate < config.orange) {
    kind = 'attention'; tier = 'orange'; title = 'Very low training';
  } else if (rate < config.yellow) {
    kind = 'attention'; tier = 'yellow'; title = 'Low training';
  } else if (rate >= config.bright) {
    kind = 'positive'; tier = 'bright'; title = 'Exceptional training';
  } else if (rate >= config.green) {
    kind = 'positive'; tier = 'green'; title = 'High training';
  }

  if (!tier) return;
  tags.push(makeTag({
    code:'auto_training_energy',
    kind,
    tier,
    category:'training',
    title,
    text:`${formatRate(rate, 0)} Gym E / day.`,
    value:rate
  }));
}

function trainingEnergyPerDay(member) {
  const candidates = [
    member?.training?.energyPerDay,
    member?.gymEnergy?.perDay,
    member?.trainingEnergy?.perDay,
    member?.trainingEnergyPerDay
  ];

  for (const value of candidates) {
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

function makeTag(tag) {
  return {
    ...tag,
    strength:tierStrength(tag.tier),
    priority:CATEGORY_PRIORITY[tag.category] || 0
  };
}

function compareTags(a, b) {
  if (a.kind !== b.kind) return a.kind === 'positive' ? -1 : 1;
  return (Number(b.strength || 0) - Number(a.strength || 0)) ||
    (Number(b.priority || 0) - Number(a.priority || 0)) ||
    String(a.title || '').localeCompare(String(b.title || ''));
}

function tierStrength(tier) {
  if (tier === 'red' || tier === 'bright') return 3;
  if (tier === 'orange' || tier === 'green') return 2;
  if (tier === 'yellow' || tier === 'teal') return 1;
  return 0;
}

function mergedSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const result = JSON.parse(JSON.stringify(DEFAULT_AUTO_TAG_SETTINGS));

  for (const key of Object.keys(result)) {
    const incoming = source[key];
    if (!incoming || typeof incoming !== 'object') continue;
    for (const field of Object.keys(result[key])) {
      if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue;
      result[key][field] = field === 'enabled'
        ? incoming[field] !== false
        : finiteOr(result[key][field], incoming[field]);
    }
  }

  return result;
}

function finiteOr(fallback, value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatRate(value, decimals) {
  return Number(value)
    .toFixed(decimals)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '');
}

function formatElapsedHours(hours) {
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remaining = hours % 24;
  return remaining ? `${days}d ${remaining}h` : `${days}d`;
}
