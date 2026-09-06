/**
 * CciParser — parses raw innerText from .agent-immobilier__document--body.mt-5
 *
 * Handles three document types:
 *   carte       → "Carte professionnelle n° : CPI..."
 *   attestation → "Attestation n° : ADC..."
 *   récépissé   → "Récépissé n° : RPA..."
 */

const ACTIVITY_LINES = new Set([
  'transactions sur immeubles et fonds de commerce',
  'transaction sur immeubles et fonds de commerce',
  'gestion immobilière',
  'gestion immobiliere',
  'syndic de copropriété',
  'syndic de copropriete',
  'syndic',
  'location saisonnière',
  'location saisonniere',
  'marchand de listes',
]);

const SECTION_STARTERS = [
  /^Carte professionnelle/i,
  /^Garantie Financière/i,
  /^Assurance\s*:?\s*$/i,
  /^Représentant légal/i,
  /^Titulaire de la carte/i,
  /^Détenteur de l'attestation/i,
  /^Dénomination\s*:/i,
  /^N° unique d'identification/i,
  /^Adresse du siège/i,
  /^Établissement\s*:?\s*$/i,
  /^Nom de naissance/i,
  /^Qualité\s*:/i,
  /^Le (?:président|vice-président)/i,
  /^Délivr/i,
  /^Valable jusqu'au/i,
];

function isSectionStarter(line) {
  return SECTION_STARTERS.some((re) => re.test(line));
}

function extract(str, regex) {
  const m = str.match(regex);
  return m ? m[1].trim() : '';
}

function parseNameLine(line) {
  const lastName  = extract(line, /Nom de naissance\s*:\s*(.+?)(?:\s{2,}|$)/);
  const usageName = extract(line, /Nom d'usage\s*:\s*(.+?)(?:\s{2,}|$)/);
  const firstName = extract(line, /Prénom\s*:\s*(.+?)(?:\s{2,}|$)/);
  return { lastName, usageName, firstName };
}

function formatName({ lastName, usageName, firstName }) {
  const parts = [firstName, lastName];
  if (usageName && usageName !== lastName) parts.push(`(${usageName})`);
  return parts.filter(Boolean).join(' ');
}

export function parseAgentRecord(raw) {
  const result = {
    document_type:                      '',
    document_number:                    '',
    card_number:                        '',
    valid_until:                        '',
    issued_by:                          '',
    president:                          '',
    activities:                         '',
    establishment_name:                 '',
    establishment_brand:                '',
    establishment_street_address:       '',
    establishment_postal_code:          '',
    establishment_city:                 '',
    company_name:                       '',
    legal_form:                         '',
    trade_name:                         '',
    street_address:                     '',
    postal_code:                        '',
    city:                               '',
    siren:                              '',
    legal_representative:               '',
    holder_lastname:                    '',
    holder_firstname:                   '',
    holder_usage_name:                  '',
    holder_quality:                     '',
    holder_powers:                      '',
    financial_guarantee_status:         '',
    financial_guarantee_amount:         '',
    financial_guarantee_provider:       '',
    financial_guarantee_street_address: '',
    financial_guarantee_postal_code:    '',
    financial_guarantee_city:           '',
    insurance_provider:                 '',
    insurance_street_address:           '',
    insurance_postal_code:              '',
    insurance_city:                     '',
  };

  if (!raw) return result;

  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  // ── Document type & number ─────────────────────────────────────────────────
  if (/^Attestation n°\s*:/i.test(lines[0])) {
    result.document_type   = 'attestation';
    result.document_number = extract(lines[0], /Attestation n°\s*:\s*(\S+)/i);
  } else if (/^Récépissé n°\s*:/i.test(lines[0])) {
    result.document_type   = 'récépissé';
    result.document_number = extract(lines[0], /Récépissé n°\s*:\s*(\S+)/i);
  } else {
    result.document_type = 'carte';
  }

  // ── Activities (carte only — lines before "Carte professionnelle n°") ──────
  if (result.document_type === 'carte') {
    const acts = [];
    for (const line of lines) {
      if (/Carte professionnelle n°/i.test(line)) break;
      if (ACTIVITY_LINES.has(line.toLowerCase())) acts.push(line);
    }
    result.activities = acts.join(' | ');
  }

  // ── Main line-by-line parse ────────────────────────────────────────────────
  let inGuarantee     = false;
  let inInsurance     = false;
  let inDetenteur     = false;
  let inAddress       = false;
  let inEstablishment = false;
  let addrLines       = [];
  let estAddrLines    = [];

  for (let i = 0; i < lines.length; i++) {
    const line  = lines[i];
    const lower = line.toLowerCase();

    // ── Section markers ──────────────────────────────────────────────────────

    if (/^Garantie Financière\s*:?\s*$/i.test(line)) {
      inGuarantee = true; inInsurance = false; inAddress = false; inEstablishment = false;
      continue;
    }
    if (/^Assurance\s*:?\s*$/i.test(line)) {
      inInsurance = true; inGuarantee = false; inAddress = false; inEstablishment = false;
      continue;
    }
    if (/^Détenteur de l'attestation\s*:?\s*$/i.test(line)) {
      inDetenteur = true; inAddress = false; inEstablishment = false;
      continue;
    }
    if (/^Adresse du siège\s*:?\s*$/i.test(line)) {
      inAddress = true; addrLines = []; inEstablishment = false;
      continue;
    }
    if (/^Établissement\s*:?\s*$/i.test(line)) {
      inEstablishment = true; inAddress = false; estAddrLines = [];
      continue;
    }
    if (/^Titulaire de la carte\s*:?\s*$/i.test(line)) {
      inDetenteur = false; inAddress = false; inEstablishment = false;
      continue;
    }

    // ── Establishment section (récépissé) ─────────────────────────────────────
    if (inEstablishment) {
      if (/^Dénomination\s*:/i.test(line)) {
        const m = line.match(/Dénomination\s*:\s*(.+)/i);
        if (m && !result.establishment_name) result.establishment_name = m[1].trim();
        continue;
      }
      if (/^(?:Enseigne|Marque|Nom commercial)\s*:/i.test(line)) {
        const m = line.match(/(?:Enseigne|Marque|Nom commercial)\s*:\s*(.+)/i);
        if (m && !result.establishment_brand) result.establishment_brand = m[1].trim();
        continue;
      }
      if (/^\d{5}\s+/.test(line)) {
        result.establishment_postal_code = line.slice(0, 5);
        result.establishment_city        = line.slice(5).trim();
        if (estAddrLines.length) result.establishment_street_address = estAddrLines.join(', ');
        estAddrLines    = [];
        inEstablishment = false;
      } else if (!isSectionStarter(line)) {
        estAddrLines.push(line);
      }
      continue;
    }

    // ── Address collector (head office) ──────────────────────────────────────
    if (inAddress) {
      addrLines.push(line);
      if (/^\d{5}\s+/.test(line)) {
        const postalLine  = addrLines.pop();
        result.street_address = result.street_address || addrLines.join(', ');
        result.postal_code    = result.postal_code    || postalLine.slice(0, 5);
        result.city           = result.city           || postalLine.slice(5).trim();
        inAddress = false;
      }
      continue;
    }

    // ── Carte professionnelle line ───────────────────────────────────────────
    if (/Carte professionnelle n°/i.test(line)) {
      inGuarantee = false; inInsurance = false; inEstablishment = false;
      const cpi = extract(line, /Carte professionnelle n°\s*:\s*(\S+)/i);
      result.card_number = cpi;
      if (result.document_type === 'carte') result.document_number = cpi;
      result.valid_until = result.valid_until ||
        extract(line, /Valable jusqu'au\s*:\s*(\d{2}\/\d{2}\/\d{4})/i);
      continue;
    }

    // ── Standalone "Valable jusqu'au" (attestation / récépissé) ─────────────
    if (/^Valable jusqu'au\s*:/i.test(line) && result.document_type !== 'carte') {
      result.valid_until = result.valid_until ||
        extract(line, /Valable jusqu'au\s*:\s*(\d{2}\/\d{2}\/\d{4})/i);
      continue;
    }

    // ── Issued by ────────────────────────────────────────────────────────────
    if (/^Délivr[eé][e]?\s+par\s*:/i.test(line) && !result.issued_by) {
      result.issued_by = line.replace(/^Délivr[eé][e]?\s+par\s*:\s*/i, '').trim();
      continue;
    }

    // ── President / Vice-President ────────────────────────────────────────────
    if (/^Le (?:président|vice-président)\s*:/i.test(line) && !result.president) {
      result.president = line.replace(/^Le (?:président|vice-président)\s*:\s*/i, '').trim();
      continue;
    }

    // ── Company name + legal form ─────────────────────────────────────────────
    if (/Dénomination\s*:/i.test(line)) {
      const nameM = line.match(/Dénomination\s*:\s*(.+?)(?:\s{2,}Forme juridique|$)/i);
      if (nameM && !result.company_name) result.company_name = nameM[1].trim();
      const formM = line.match(/Forme juridique\s*:\s*(.+)/i);
      if (formM && !result.legal_form) result.legal_form = formM[1].trim();
      continue;
    }

    // ── Trade name ───────────────────────────────────────────────────────────
    if (/(?:Nom commercial|Enseigne)\s*:/i.test(line) && !result.trade_name) {
      const m = line.match(/(?:Nom commercial|Enseigne)\s*:\s*(.+?)(?:\s{2,}N° unique|$)/i);
      if (m) result.trade_name = m[1].trim();
    }

    // ── SIREN ─────────────────────────────────────────────────────────────────
    if (/N° unique d'identification\s*:/i.test(line) && !result.siren) {
      result.siren = extract(line, /N° unique d'identification\s*:\s*(\d+)/i);
      continue;
    }

    // ── Legal representative ──────────────────────────────────────────────────
    if (/^Représentant légal\s*(?::\s*\d*\s*)?$/i.test(line)) {
      const nextLine = lines[i + 1] ?? '';
      if (/Nom de naissance/i.test(nextLine)) {
        const name = formatName(parseNameLine(nextLine));
        result.legal_representative = result.legal_representative
          ? result.legal_representative + ' | ' + name
          : name;
      }
      continue;
    }

    // ── Détenteur ─────────────────────────────────────────────────────────────
    if (inDetenteur && /Nom de naissance/i.test(line) && !result.holder_lastname) {
      const { lastName, usageName, firstName } = parseNameLine(line);
      result.holder_lastname   = lastName;
      result.holder_firstname  = firstName;
      result.holder_usage_name = usageName;
      inDetenteur = false;
      continue;
    }

    // ── Qualité ───────────────────────────────────────────────────────────────
    if (/^Qualité\s*:/i.test(line)) {
      result.holder_quality = line.replace(/^Qualité\s*:\s*/i, '').trim();
      continue;
    }

    // ── Étendue des pouvoirs ──────────────────────────────────────────────────
    if (/^Étendue des pouvoirs\s*:/i.test(line)) {
      let powers = line.replace(/^Étendue des pouvoirs\s*:\s*/i, '').trim();
      let j = i + 1;
      while (j < lines.length && !isSectionStarter(lines[j])) {
        powers += ' ' + lines[j];
        j++;
      }
      result.holder_powers = powers.trim();
      i = j - 1;
      continue;
    }

    // ── Guarantee section ─────────────────────────────────────────────────────
    if (inGuarantee) {
      if (/Montant de la garantie\s*:/i.test(line) && !result.financial_guarantee_amount) {
        result.financial_guarantee_amount = extract(line, /Montant de la garantie\s*:\s*(.+)/i);
        continue;
      }
      if (/Non détention de fonds/i.test(line)) {
        result.financial_guarantee_status = result.financial_guarantee_status
          ? result.financial_guarantee_status + ' | Non détention de fonds'
          : 'Non détention de fonds';
        continue;
      }
      if (/Absence de garantie financière/i.test(line)) {
        result.financial_guarantee_status = result.financial_guarantee_status
          ? result.financial_guarantee_status + ' | Absence de garantie financière'
          : 'Absence de garantie financière';
        continue;
      }
      // Provider: first non-activity, non-status, non-digit line
      if (!result.financial_guarantee_provider
          && !ACTIVITY_LINES.has(lower)
          && !/^\d/.test(line)) {
        result.financial_guarantee_provider = line;
        continue;
      }
      // Address lines after provider
      if (result.financial_guarantee_provider && !result.financial_guarantee_postal_code) {
        if (/^\d{5}\s+/.test(line)) {
          result.financial_guarantee_postal_code = line.slice(0, 5);
          result.financial_guarantee_city        = line.slice(5).trim();
        } else {
          result.financial_guarantee_street_address = result.financial_guarantee_street_address
            ? result.financial_guarantee_street_address + ', ' + line
            : line;
        }
      }
      continue;
    }

    // ── Insurance section ─────────────────────────────────────────────────────
    if (inInsurance) {
      if (!result.insurance_provider
          && !ACTIVITY_LINES.has(lower)
          && !/^\d/.test(line)) {
        result.insurance_provider = line;
        continue;
      }
      if (result.insurance_provider && !result.insurance_postal_code) {
        if (/^\d{5}\s+/.test(line)) {
          result.insurance_postal_code = line.slice(0, 5);
          result.insurance_city        = line.slice(5).trim();
        } else {
          result.insurance_street_address = result.insurance_street_address
            ? result.insurance_street_address + ', ' + line
            : line;
        }
      }
      continue;
    }
  }

  return result;
}
