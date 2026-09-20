const CONFIG_KEY = 'payout_profile_v1';

export const PAYOUT_MODULE_CATALOG = [
  {
    id:'rankedRespect',
    group:'Respect',
    label:'Ranked-war respect',
    shortLabel:'War R',
    unit:'R',
    kind:'respect',
    defaultEnabled:true,
    defaultRate:120000,
    supportsPercentage:true,
    defaultPercentageBased:false,
    defaultPool:0,
    supportsMilestones:true,
    defaultMilestonesIncluded:false,
    defaultMilestoneRate:1200000
  },
  {
    id:'outsideChainRespect',
    group:'Respect',
    label:'Outside-chain respect',
    shortLabel:'Outside R',
    unit:'R',
    kind:'respect',
    defaultEnabled:true,
    defaultRate:80000,
    supportsMilestones:true,
    defaultMilestonesIncluded:false,
    defaultMilestoneRate:800000
  },
  {
    id:'warHits',
    group:'Hits',
    label:'War hits',
    shortLabel:'War hits',
    unit:'hit',
    kind:'count',
    defaultEnabled:false,
    defaultRate:0,
    supportsPercentage:true,
    defaultPercentageBased:false,
    defaultPool:0,
    supportsMilestones:false
  },
  {
    id:'assists',
    group:'Hits',
    label:'Assists',
    shortLabel:'Assists',
    unit:'assist',
    kind:'count',
    defaultEnabled:false,
    defaultRate:0,
    supportsMilestones:false
  },
  {
    id:'outsideHits',
    group:'Hits',
    label:'Outside hits',
    shortLabel:'Outside hits',
    unit:'hit',
    kind:'count',
    defaultEnabled:false,
    defaultRate:0,
    supportsMilestones:false
  }
];

export const DEFAULT_PAYOUT_PROFILE = {
  version:2,
  factionCutPercent:0,
  modules:PAYOUT_MODULE_CATALOG.map(definition => ({
    id:definition.id,
    enabled:definition.defaultEnabled,
    rate:definition.defaultRate,
    ...(definition.supportsPercentage ? {
      percentageBased:definition.defaultPercentageBased,
      pool:definition.defaultPool
    } : {}),
    ...(definition.supportsMilestones ? {
      milestonesIncluded:definition.defaultMilestonesIncluded,
      milestoneRate:definition.defaultMilestoneRate
    } : {})
  }))
};

export function payoutCatalog() {
  return PAYOUT_MODULE_CATALOG.map(item => ({ ...item }));
}

export function cloneDefaultPayoutProfile() {
  return JSON.parse(JSON.stringify(DEFAULT_PAYOUT_PROFILE));
}

export function normalizePayoutProfile(value) {
  const source = value && typeof value === 'object' ? value : {};
  const incomingModules = Array.isArray(source.modules) ? source.modules : [];
  const incomingById = new Map(
    incomingModules
      .filter(item => item && typeof item === 'object')
      .map(item => [String(item.id || ''), item])
  );

  const modules = PAYOUT_MODULE_CATALOG.map(definition => {
    const incoming = incomingById.get(definition.id) || {};
    const module = {
      id:definition.id,
      enabled:Object.prototype.hasOwnProperty.call(incoming, 'enabled')
        ? incoming.enabled !== false
        : definition.defaultEnabled,
      rate:boundedNumber(
        Object.prototype.hasOwnProperty.call(incoming, 'rate')
          ? incoming.rate
          : definition.defaultRate,
        definition.label + ' rate',
        0,
        100000000
      )
    };

    if (definition.supportsPercentage) {
      module.percentageBased = Object.prototype.hasOwnProperty.call(incoming, 'percentageBased')
        ? incoming.percentageBased === true
        : definition.defaultPercentageBased;
      module.pool = boundedNumber(
        Object.prototype.hasOwnProperty.call(incoming, 'pool')
          ? incoming.pool
          : definition.defaultPool,
        definition.label + ' payout pool',
        0,
        100000000000
      );
    }

    if (definition.supportsMilestones) {
      const hasNewIncluded = Object.prototype.hasOwnProperty.call(incoming, 'milestonesIncluded');
      const legacyNormalize = Object.prototype.hasOwnProperty.call(incoming, 'normalizeMilestones')
        ? incoming.normalizeMilestones !== false
        : null;

      module.milestonesIncluded = hasNewIncluded
        ? incoming.milestonesIncluded !== false
        : legacyNormalize === null
          ? definition.defaultMilestonesIncluded
          : !legacyNormalize;

      const legacyMilestoneValue = boundedNumber(
        Object.prototype.hasOwnProperty.call(incoming, 'milestoneValue')
          ? incoming.milestoneValue
          : 10,
        definition.label + ' legacy milestone value',
        0,
        1000
      );

      module.milestoneRate = boundedNumber(
        Object.prototype.hasOwnProperty.call(incoming, 'milestoneRate')
          ? incoming.milestoneRate
          : legacyNormalize === true
            ? legacyMilestoneValue * module.rate
            : definition.defaultMilestoneRate,
        definition.label + ' milestone rate',
        0,
        100000000
      );
    }

    return module;
  });

  const factionCutPercent = boundedNumber(
    Object.prototype.hasOwnProperty.call(source, 'factionCutPercent')
      ? source.factionCutPercent
      : 0,
    'Faction cut',
    0,
    100
  );

  return { version:2, factionCutPercent, modules };
}

export async function loadPayoutProfile(db, factionId) {
  const row = await db.prepare(
    'SELECT config_value FROM faction_config WHERE faction_id = ? AND config_key = ? LIMIT 1'
  ).bind(factionId, CONFIG_KEY).first();

  if (!row?.config_value) return cloneDefaultPayoutProfile();

  try {
    return normalizePayoutProfile(JSON.parse(String(row.config_value)));
  } catch (_) {
    return cloneDefaultPayoutProfile();
  }
}

export async function savePayoutProfile(db, factionId, profile) {
  const normalized = normalizePayoutProfile(profile);
  const now = unixNow();

  await db.prepare(`
    INSERT INTO faction_config (
      faction_id, config_key, config_value, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(faction_id, config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = excluded.updated_at
  `).bind(
    factionId,
    CONFIG_KEY,
    JSON.stringify(normalized),
    now,
    now
  ).run();

  return normalized;
}

export async function resetPayoutProfile(db, factionId) {
  await db.prepare(
    'DELETE FROM faction_config WHERE faction_id = ? AND config_key = ?'
  ).bind(factionId, CONFIG_KEY).run();

  return cloneDefaultPayoutProfile();
}

export function calculatePayoutRows(rows, profileValue) {
  const profile = normalizePayoutProfile(profileValue);
  const definitions = new Map(PAYOUT_MODULE_CATALOG.map(item => [item.id, item]));
  const modules = profile.modules;
  const factionCutPercent = Number(profile.factionCutPercent || 0);

  const members = (Array.isArray(rows) ? rows : []).map(row => {
    const components = modules.map(module => {
      const definition = definitions.get(module.id);
      const enabled = module.enabled !== false;
      const percentageBased = Boolean(definition?.supportsPercentage && module.percentageBased === true);
      const rawQuantity = rawModuleQuantity(module.id, row);
      let quantity = rawQuantity;
      let adjustment = 0;

      const milestone = definition?.supportsMilestones
        ? milestoneData(module.id, row)
        : { hits:0, rawRespect:0 };
      const milestonesIncluded = definition?.supportsMilestones
        ? module.milestonesIncluded !== false
        : true;

      let milestonePayout = 0;
      if (definition?.supportsMilestones && !milestonesIncluded) {
        quantity = Math.max(0, rawQuantity - milestone.rawRespect);
        adjustment = quantity - rawQuantity;
        if (enabled) {
          milestonePayout = Math.round(
            milestone.hits * Number(module.milestoneRate || 0)
          );
        }
      }

      const basePayout = enabled && !percentageBased
        ? Math.round(quantity * Number(module.rate || 0))
        : 0;

      return {
        id:module.id,
        label:definition?.label || module.id,
        shortLabel:definition?.shortLabel || module.id,
        unit:definition?.unit || '',
        enabled,
        rate:Number(module.rate || 0),
        percentageBased,
        pool:definition?.supportsPercentage ? Number(module.pool || 0) : 0,
        rawQuantity,
        quantity,
        adjustment,
        contributionPercent:0,
        basePayout,
        payout:basePayout + milestonePayout,
        ...(definition?.supportsMilestones ? {
          milestonesIncluded,
          milestoneHits:Number(milestone.hits || 0),
          milestoneRespect:Number(milestone.rawRespect || 0),
          milestoneRate:Number(module.milestoneRate || 0),
          milestonePayout
        } : {})
      };
    });

    return {
      playerId:Number((row.player_id ?? row.playerId) || 0),
      playerName:String((row.player_name ?? row.playerName) || 'Unknown'),
      components,
      totalPayout:0
    };
  }).filter(member => member.playerId > 0);

  for (const module of modules) {
    const definition = definitions.get(module.id);
    if (
      module.enabled === false ||
      !definition?.supportsPercentage ||
      module.percentageBased !== true
    ) continue;

    const targets = members
      .map(member => ({
        member,
        component:member.components.find(component => component.id === module.id)
      }))
      .filter(item => item.component);

    const totalContribution = targets.reduce(
      (sum, item) => sum + Number(item.component.quantity || 0),
      0
    );
    const pool = Math.round(Number(module.pool || 0));
    const distributablePool = Math.max(
      0,
      Math.round(pool * (1 - factionCutPercent / 100))
    );

    const allocations = targets.map((item, index) => {
      const quantity = Number(item.component.quantity || 0);
      const exact = totalContribution > 0
        ? distributablePool * quantity / totalContribution
        : 0;
      const floor = Math.floor(exact);
      return {
        ...item,
        index,
        exact,
        floor,
        fraction:exact - floor
      };
    });

    let remainder = distributablePool - allocations.reduce((sum, item) => sum + item.floor, 0);
    allocations.sort((a, b) =>
      b.fraction - a.fraction ||
      Number(b.component.quantity || 0) - Number(a.component.quantity || 0) ||
      String(a.member.playerName || '').localeCompare(String(b.member.playerName || ''), undefined, {
        sensitivity:'base',
        numeric:true
      })
    );

    for (const allocation of allocations) {
      const extra = remainder > 0 && totalContribution > 0 ? 1 : 0;
      if (extra) remainder -= 1;

      const component = allocation.component;
      component.contributionPercent = totalContribution > 0
        ? Number(component.quantity || 0) / totalContribution * 100
        : 0;
      component.basePayout = allocation.floor + extra;
      component.payout = component.basePayout + Number(component.milestonePayout || 0);
      component.factionContributionTotal = totalContribution;
      component.distributablePool = distributablePool;
    }
  }

  for (const member of members) {
    member.totalPayout = member.components.reduce(
      (sum, component) => sum + Number(component.payout || 0),
      0
    );
  }

  members.sort((a, b) =>
    b.totalPayout - a.totalPayout ||
    a.playerName.localeCompare(b.playerName, undefined, { sensitivity:'base', numeric:true })
  );

  const moduleTotals = modules.map(module => {
    const definition = definitions.get(module.id);
    const memberComponents = members
      .map(member => member.components.find(component => component.id === module.id))
      .filter(Boolean);
    const percentageBased = Boolean(definition?.supportsPercentage && module.percentageBased === true);
    const pool = percentageBased ? Math.round(Number(module.pool || 0)) : 0;
    const distributablePool = percentageBased
      ? Math.max(0, Math.round(pool * (1 - factionCutPercent / 100)))
      : 0;

    return {
      id:module.id,
      label:definition?.label || module.id,
      shortLabel:definition?.shortLabel || module.id,
      unit:definition?.unit || '',
      enabled:module.enabled !== false,
      rate:Number(module.rate || 0),
      percentageBased,
      pool,
      factionCutPercent:percentageBased ? factionCutPercent : 0,
      factionCutAmount:percentageBased ? pool - distributablePool : 0,
      distributablePool,
      quantity:memberComponents.reduce((sum, component) => sum + Number(component.quantity || 0), 0),
      payout:memberComponents.reduce((sum, component) => sum + Number(component.payout || 0), 0)
    };
  });

  return {
    profile,
    modules:moduleTotals,
    activeModules:moduleTotals.filter(module => module.enabled !== false),
    factionCutPercent,
    members,
    totalPayout:members.reduce((sum, member) => sum + member.totalPayout, 0)
  };
}

function rawModuleQuantity(id, row) {
  if (id === 'rankedRespect') {
    // Ranked-war payouts use the same stored war score shown in the member table.
    return nonNegative(row.score_up ?? row.scoreUp ?? row.respect_earned ?? row.rankedRespect ?? 0);
  }
  if (id === 'outsideChainRespect') {
    return nonNegative(row.outside_chain_respect ?? row.outsideChainRespect ?? 0);
  }
  if (id === 'warHits') {
    return nonNegative(row.war_hits ?? row.warHits ?? row.hits ?? 0);
  }
  if (id === 'assists') {
    return nonNegative(row.assists ?? 0);
  }
  if (id === 'outsideHits') {
    return nonNegative(row.outside_hits ?? row.outsideHits ?? 0);
  }
  return 0;
}

function milestoneData(id, row) {
  if (id === 'rankedRespect') {
    return {
      hits:nonNegative(row.chain_bonus_hits ?? row.chainBonusHits ?? 0),
      rawRespect:nonNegative(row.chain_bonus_score ?? row.chainBonusRespect ?? 0)
    };
  }
  if (id === 'outsideChainRespect') {
    return {
      hits:nonNegative(row.outside_chain_bonus_hits ?? row.outsideChainBonusHits ?? 0),
      rawRespect:nonNegative(row.outside_chain_bonus_respect ?? row.outsideChainBonusRespect ?? 0)
    };
  }
  return { hits:0, rawRespect:0 };
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function boundedNumber(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(label + ' must be between ' + min + ' and ' + max + '.');
  }
  return number;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}
