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
  version:1,
  modules:PAYOUT_MODULE_CATALOG.map(definition => ({
    id:definition.id,
    enabled:definition.defaultEnabled,
    rate:definition.defaultRate,
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

  return { version:1, modules };
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
  const activeModules = modules.filter(module => module.enabled !== false);

  const members = (Array.isArray(rows) ? rows : []).map(row => {
    const components = modules.map(module => {
      const definition = definitions.get(module.id);
      const enabled = module.enabled !== false;
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

      const basePayout = enabled
        ? Math.round(quantity * Number(module.rate || 0))
        : 0;
      const payout = basePayout + milestonePayout;

      return {
        id:module.id,
        label:definition?.label || module.id,
        shortLabel:definition?.shortLabel || module.id,
        unit:definition?.unit || '',
        enabled,
        rate:Number(module.rate || 0),
        rawQuantity,
        quantity,
        adjustment,
        payout,
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
      totalPayout:components.reduce((sum, component) => sum + component.payout, 0)
    };
  }).filter(member => member.playerId > 0);

  members.sort((a, b) =>
    b.totalPayout - a.totalPayout ||
    a.playerName.localeCompare(b.playerName, undefined, { sensitivity:'base', numeric:true })
  );

  const moduleTotals = modules.map(module => {
    const definition = definitions.get(module.id);
    const memberComponents = members
      .map(member => member.components.find(component => component.id === module.id))
      .filter(Boolean);

    return {
      id:module.id,
      label:definition?.label || module.id,
      shortLabel:definition?.shortLabel || module.id,
      unit:definition?.unit || '',
      enabled:module.enabled !== false,
      rate:Number(module.rate || 0),
      quantity:memberComponents.reduce((sum, component) => sum + Number(component.quantity || 0), 0),
      payout:memberComponents.reduce((sum, component) => sum + Number(component.payout || 0), 0)
    };
  });

  return {
    profile,
    modules:moduleTotals,
    activeModules:moduleTotals.filter(module => module.enabled !== false),
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
