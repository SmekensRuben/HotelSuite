const { onSchedule, logger, admin, Resend, RESEND_API_KEY, RESEND_FROM } = require('./config');

const db = admin.firestore();
const SCHEDULED_MAIL_DOC_PATH = 'scheduledMails/scheduledBlockPickupMail';
const DEFAULT_TIMEZONE = 'Europe/Amsterdam';

function sanitizeEmails(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
}

function sanitizeHotelUids(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeDateValue(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return null;
  }

  if (value?.toDate instanceof Function) return value.toDate().toISOString().slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return null;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPickupRoomsValue(allotmentDateEntry) {
  return Number(allotmentDateEntry?.pickupRooms ?? allotmentDateEntry?.pickuprooms ?? 0);
}

function formatPickupSummaries(allotmentDates) {
  if (!Array.isArray(allotmentDates)) return [];

  return allotmentDates
    .map((entry) => ({
      allotmentDate: String(entry?.allotmentDate || '').trim(),
      pickupRooms: getPickupRoomsValue(entry),
    }))
    .filter((entry) => entry.pickupRooms > 0)
    .map((entry) => `${entry.allotmentDate || '-'} (${entry.pickupRooms})`);
}

async function getLatestSnapshotDate(hotelUid) {
  const snapshotDatesSnap = await db
    .collection('hotels')
    .doc(hotelUid)
    .collection('reports')
    .doc('grouppickup')
    .collection('snapshotDates')
    .get();

  return snapshotDatesSnap.docs
    .map((docSnap) => normalizeDateValue(docSnap.id) || normalizeDateValue(docSnap.data()?.snapshotDate))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))[0] || null;
}

async function getGroupsForSnapshotDate(hotelUid, snapshotDate) {
  if (!snapshotDate) return [];

  const groupsSnap = await db
    .collection('hotels')
    .doc(hotelUid)
    .collection('reports')
    .doc('grouppickup')
    .collection('snapshotDates')
    .doc(snapshotDate)
    .collection('groups')
    .get();

  return groupsSnap.docs
    .map((docSnap) => {
      const data = docSnap.data() || {};
      const bookingStatus = String(data.bookingStatus || '').trim();
      const pickupSummaries = formatPickupSummaries(data.allotmentDates);
      if (bookingStatus !== 'DEF' || !pickupSummaries.length) return null;

      return {
        blockId: docSnap.id,
        description: String(data.description || '').trim(),
        allotmentCode: String(data.allotmentCode || '').trim(),
        ownerCode: String(data.ownerCode || '').trim(),
        bookingStatus,
        pickupSummaries,
      };
    })
    .filter(Boolean);
}

function buildEmailHtml(hotelReports) {
  const sections = hotelReports
    .map((report) => {
      const rowsHtml = report.groups
        .map(
          (group) => `
            <tr>
              <td style="padding: 8px; border: 1px solid #e5e7eb;">${escapeHtml(group.blockId)}</td>
              <td style="padding: 8px; border: 1px solid #e5e7eb;">${escapeHtml(group.description || '-')}</td>
              <td style="padding: 8px; border: 1px solid #e5e7eb;">${escapeHtml(group.allotmentCode || '-')}</td>
              <td style="padding: 8px; border: 1px solid #e5e7eb;">${escapeHtml(group.ownerCode || '-')}</td>
              <td style="padding: 8px; border: 1px solid #e5e7eb;">${escapeHtml(group.bookingStatus || '-')}</td>
              <td style="padding: 8px; border: 1px solid #e5e7eb;">${escapeHtml(group.pickupSummaries.join(', '))}</td>
            </tr>
          `
        )
        .join('');

      return `
        <h2 style="margin: 24px 0 8px; font-size: 18px;">${escapeHtml(report.hotelName)} (${escapeHtml(
        report.hotelUid
      )})</h2>
        <p style="margin: 0 0 12px; color: #374151;">Snapshot datum: <strong>${escapeHtml(
          report.snapshotDate
        )}</strong> · Openstaande blocks: <strong>${report.groups.length}</strong></p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 12px;">
          <thead>
            <tr style="background: #f3f4f6; text-align: left;">
              <th style="padding: 8px; border: 1px solid #e5e7eb;">Block ID</th>
              <th style="padding: 8px; border: 1px solid #e5e7eb;">Description</th>
              <th style="padding: 8px; border: 1px solid #e5e7eb;">Allotment code</th>
              <th style="padding: 8px; border: 1px solid #e5e7eb;">Owner code</th>
              <th style="padding: 8px; border: 1px solid #e5e7eb;">Booking status</th>
              <th style="padding: 8px; border: 1px solid #e5e7eb;">Pickup rooms per date</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      `;
    })
    .join('');

  return `
    <div style="font-family: Arial, sans-serif; color: #111827;">
      <h1 style="margin: 0 0 12px; font-size: 20px;">Scheduled block pickup report</h1>
      <p style="margin: 0 0 16px; color: #374151;">
        Overzicht van alle blocks met bookingStatus <strong>DEF</strong> waarvoor nog pickup rooms openstaan in de meest recente snapshot.
      </p>
      ${sections}
    </div>
  `;
}

async function getHotelName(hotelUid) {
  const hotelSnap = await db.collection('hotels').doc(hotelUid).get();
  if (!hotelSnap.exists) return hotelUid;
  return String(hotelSnap.data()?.hotelName || hotelUid).trim() || hotelUid;
}

async function sendScheduledBlockPickupReportHandler() {
  const scheduleSnap = await db.doc(SCHEDULED_MAIL_DOC_PATH).get();
  if (!scheduleSnap.exists) {
    logger.warn('scheduledBlockPickupMail config not found; skipping send');
    return;
  }

  const scheduleConfig = scheduleSnap.data() || {};
  const to = sanitizeEmails(scheduleConfig.mailto);
  const hotelUids = sanitizeHotelUids(scheduleConfig.hotelUids);

  if (!to.length) throw new Error('No valid mailto addresses found in scheduledBlockPickupMail');
  if (!hotelUids.length) throw new Error('No hotelUids found in scheduledBlockPickupMail');

  const hotelReports = [];

  for (const hotelUid of hotelUids) {
    const snapshotDate = await getLatestSnapshotDate(hotelUid);
    if (!snapshotDate) {
      logger.info('No group pickup snapshot dates found', { hotelUid });
      continue;
    }

    const groups = await getGroupsForSnapshotDate(hotelUid, snapshotDate);
    if (!groups.length) {
      logger.info('No qualifying groups found for block pickup report', { hotelUid, snapshotDate });
      continue;
    }

    const hotelName = await getHotelName(hotelUid);
    hotelReports.push({ hotelUid, hotelName, snapshotDate, groups });
  }

  if (!hotelReports.length) {
    logger.info('No block pickup report entries found; skipping email send');
    await db.doc(SCHEDULED_MAIL_DOC_PATH).set(
      {
        lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
        lastRunStatus: 'no_data',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return;
  }

  const resendApiKey = RESEND_API_KEY.value();
  const resendFrom = RESEND_FROM.value();
  const resend = new Resend(resendApiKey);

  const totalGroups = hotelReports.reduce((sum, report) => sum + report.groups.length, 0);
  const subject = `Block pickup report (${totalGroups} open blocks)`;
  const html = buildEmailHtml(hotelReports);

  const response = await resend.emails.send({
    from: resendFrom,
    to,
    subject,
    html,
    text: `Scheduled block pickup report met ${totalGroups} open blocks over ${hotelReports.length} hotel(s).`,
  });

  await db.doc(SCHEDULED_MAIL_DOC_PATH).set(
    {
      lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSentTo: to,
      lastHotelUids: hotelUids,
      lastGroupCount: totalGroups,
      lastHotelCount: hotelReports.length,
      lastRunStatus: 'sent',
      lastMailId: response?.data?.id || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  logger.info('Scheduled block pickup report sent', {
    recipients: to.length,
    hotelCount: hotelReports.length,
    groupCount: totalGroups,
  });
}

const sendScheduledBlockPickupReport = onSchedule(
  {
    schedule: '30 6 * * *',
    timeZone: DEFAULT_TIMEZONE,
    secrets: [RESEND_API_KEY, RESEND_FROM],
  },
  async () => {
    await sendScheduledBlockPickupReportHandler();
  }
);

module.exports = { sendScheduledBlockPickupReport };
