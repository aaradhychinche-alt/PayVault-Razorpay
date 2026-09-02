'use strict';
/**
 * src/models/resolution.js
 *
 * Domain model and enums for Exception Resolution & Case Lifecycle (Chunk 3).
 *
 * Lifecyle Statuses:
 *   - OPEN: Exception detected, awaiting review or investigation.
 *   - IN_REVIEW: AI investigation run or manual review actively in progress.
 *   - RESOLVED: Confirmed and finalized by human operator with documented reason & notes.
 *
 * Transitions:
 *   OPEN → IN_REVIEW → RESOLVED
 *   RESOLVED → OPEN (Reopen, preserving audit history)
 */

const CaseStatus = Object.freeze({
  OPEN:      'OPEN',
  IN_REVIEW: 'IN_REVIEW',
  RESOLVED:  'RESOLVED',
});

const ResolutionReason = Object.freeze({
  DUPLICATE_PAYMENT_CONFIRMED: 'DUPLICATE_PAYMENT_CONFIRMED',
  MERCHANT_RECORD_CORRECTED:   'MERCHANT_RECORD_CORRECTED',
  GATEWAY_ISSUE_CONFIRMED:     'GATEWAY_ISSUE_CONFIRMED',
  NO_ACTUAL_FINANCIAL_LOSS:    'NO_ACTUAL_FINANCIAL_LOSS',
  FALSE_POSITIVE:              'FALSE_POSITIVE',
  OTHER:                       'OTHER',
});

const ResolutionReasonDetails = Object.freeze({
  [ResolutionReason.DUPLICATE_PAYMENT_CONFIRMED]: {
    id:          ResolutionReason.DUPLICATE_PAYMENT_CONFIRMED,
    label:       'Duplicate payment confirmed',
    description: 'Duplicate settlement credit or payment confirmed by bank/merchant records.',
    category:    'CONFIRMED_ISSUE',
  },
  [ResolutionReason.MERCHANT_RECORD_CORRECTED]: {
    id:          ResolutionReason.MERCHANT_RECORD_CORRECTED,
    label:       'Merchant record corrected',
    description: 'Merchant ledger or order record was missing/incorrect and has been updated in ERP.',
    category:    'CORRECTION',
  },
  [ResolutionReason.GATEWAY_ISSUE_CONFIRMED]: {
    id:          ResolutionReason.GATEWAY_ISSUE_CONFIRMED,
    label:       'Gateway issue confirmed',
    description: 'Payment gateway fee or timing discrepancy confirmed with provider.',
    category:    'PROVIDER_ISSUE',
  },
  [ResolutionReason.NO_ACTUAL_FINANCIAL_LOSS]: {
    id:          ResolutionReason.NO_ACTUAL_FINANCIAL_LOSS,
    label:       'No actual financial loss',
    description: 'Reconciliation variance resolved with net-neutral financial impact.',
    category:    'NO_LOSS',
  },
  [ResolutionReason.FALSE_POSITIVE]: {
    id:          ResolutionReason.FALSE_POSITIVE,
    label:       'False positive',
    description: 'Exception flagged due to timing or unlinked record that reconciled cleanly.',
    category:    'FALSE_ALARM',
  },
  [ResolutionReason.OTHER]: {
    id:          ResolutionReason.OTHER,
    label:       'Other',
    description: 'Manual operator exception resolution documented in notes.',
    category:    'CUSTOM',
  },
});

/**
 * Validate resolution reason against enum.
 */
function isValidResolutionReason(reason) {
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(ResolutionReason, reason);
}

let _auditCounter = 1;

/**
 * Reset audit sequence counter (for testing).
 */
function resetAuditCounter() {
  _auditCounter = 1;
}

/**
 * Create a typed Resolution Record.
 *
 * @param {object} params
 * @param {string} params.case_id
 * @param {string} params.resolution_reason
 * @param {string} [params.resolution_notes]
 * @param {string} [params.resolved_by]
 * @param {number} [params.resolved_at]
 * @returns {object}
 */
function createResolutionRecord({
  case_id,
  resolution_reason,
  resolution_notes = '',
  resolved_by = 'user',
  resolved_at = Math.floor(Date.now() / 1000),
}) {
  if (!case_id) {
    throw new Error('createResolutionRecord: case_id is required');
  }
  if (!isValidResolutionReason(resolution_reason)) {
    throw new Error(`createResolutionRecord: invalid resolution_reason '${resolution_reason}'. Must be one of: ${Object.keys(ResolutionReason).join(', ')}`);
  }

  const reasonInfo = ResolutionReasonDetails[resolution_reason] || { label: resolution_reason };

  return {
    case_id,
    status:                  CaseStatus.RESOLVED,
    resolution_reason,
    resolution_reason_label: reasonInfo.label,
    resolution_notes:        typeof resolution_notes === 'string' ? resolution_notes.trim() : '',
    resolved_at,
    resolved_at_iso:         new Date(resolved_at * 1000).toISOString(),
    resolved_by:             resolved_by || 'user',
  };
}

/**
 * Create an append-only Audit Event.
 *
 * @param {object} params
 * @param {string} params.case_id
 * @param {string} params.action - 'CREATED' | 'START_REVIEW' | 'RESOLVED' | 'REOPENED'
 * @param {string} params.previous_status
 * @param {string} params.new_status
 * @param {string} [params.resolution_reason]
 * @param {string} [params.notes]
 * @param {string} [params.performed_by]
 * @param {number} [params.created_at]
 * @returns {object}
 */
function createAuditEvent({
  case_id,
  action,
  previous_status,
  new_status,
  resolution_reason = null,
  notes = '',
  performed_by = 'user',
  created_at = Math.floor(Date.now() / 1000),
}) {
  if (!case_id) throw new Error('createAuditEvent: case_id is required');
  if (!action) throw new Error('createAuditEvent: action is required');

  const seqId = `audit_${String(_auditCounter++).padStart(6, '0')}`;

  return {
    id:                seqId,
    case_id,
    action,
    previous_status:   previous_status || null,
    new_status:        new_status      || null,
    resolution_reason: resolution_reason || null,
    notes:             typeof notes === 'string' ? notes.trim() : '',
    performed_by:      performed_by || 'user',
    created_at,
    created_at_iso:    new Date(created_at * 1000).toISOString(),
  };
}

module.exports = {
  CaseStatus,
  ResolutionReason,
  ResolutionReasonDetails,
  isValidResolutionReason,
  createResolutionRecord,
  createAuditEvent,
  resetAuditCounter,
};
