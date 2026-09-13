import React from "react";
import { categoryDefaultsForEvent, DEMAND_EFFECTS, IMPACT_LEVELS, SYSTEM_TYPES, optionEntries } from "../../constants/demandCalendar";

const control = "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-[#b41f1f] focus:outline-none focus:ring-2 focus:ring-red-100";
function Field({ label, name, error, required, children }) {
  return <label className="block text-sm font-medium text-gray-700">{label}{required && <span className="text-red-600"> *</span>}{children}<span className="mt-1 block text-xs text-red-600">{error || ""}</span></label>;
}
function Select({ name, value, onChange, options, placeholder, disabled }) {
  return <select className={control} id={name} name={name} value={value} onChange={onChange} disabled={disabled}><option value="">{placeholder || "Select…"}</option>{optionEntries(options).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}
function Text({ name, value, onChange, type = "text", min }) { return <input className={control} id={name} name={name} value={value} onChange={onChange} type={type} min={min} />; }

export default function DemandCalendarEventForm({ value, setValue, errors = {}, categories }) {
  const change = (event) => setValue((current) => ({ ...current, [event.target.name]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  const selectCategory = (event) => {
    const category = categories.find((item) => item.id === event.target.value);
    setValue((current) => ({ ...current, categoryId: event.target.value, ...(category ? categoryDefaultsForEvent(category) : {}) }));
  };
  const effectFields = [["groupDemandEffect", "Group Demand Effect"], ["transientBusinessEffect", "Business Transient Effect"], ["transientLeisureEffect", "Leisure Transient Effect"], ["bqtDemandEffect", "Banqueting Demand Effect"]];
  return <div className="space-y-6">
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm"><h2 className="mb-4 text-lg font-semibold">Event Information</h2><div className="grid gap-4 sm:grid-cols-2">
      <Field label="Event / Period Name" required error={errors.name}><Text name="name" value={value.name} onChange={change} /></Field>
      <Field label="Category" required error={errors.categoryId}><select className={control} name="categoryId" value={value.categoryId} onChange={selectCategory}><option value="">Select…</option>{categories.filter((c) => c.active || c.id === value.categoryId).map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select></Field>
      <Field label="System Type" required error={errors.systemType}><Select name="systemType" value={value.systemType} onChange={change} options={SYSTEM_TYPES} /></Field>
      <Field label="Region / Market" required error={errors.region}><Text name="region" value={value.region} onChange={change} /></Field>
      <Field label="Start Date" required error={errors.startDate}><Text type="date" name="startDate" value={value.startDate} onChange={change} /></Field>
      <Field label="End Date" required error={errors.endDate}><Text type="date" name="endDate" value={value.endDate} onChange={change} /></Field>
      <Field label="Venue"><Text name="venue" value={value.venue} onChange={change} /></Field>
    </div></section>
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm"><h2 className="mb-4 text-lg font-semibold">Demand Impact</h2><p className="mb-4 text-sm text-gray-500">Category defaults are copied into this event and can be overridden.</p><div className="grid gap-4 sm:grid-cols-2">
      <Field label="Impact Level" required error={errors.impactLevel}><Select name="impactLevel" value={value.impactLevel} onChange={change} options={IMPACT_LEVELS} /></Field>
      {effectFields.map(([name, label]) => <Field key={name} label={label} required error={errors[name]}><Select name={name} value={value[name]} onChange={change} options={DEMAND_EFFECTS} /></Field>)}
      <Field label="Confidence"><Select name="confidence" value={value.confidence} onChange={change} options={IMPACT_LEVELS} placeholder="Not specified" /></Field>
    </div></section>
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm"><h2 className="mb-4 text-lg font-semibold">Additional Information</h2><div className="grid gap-4 sm:grid-cols-2">
      <Field label="Expected Attendance" error={errors.expectedAttendance}><Text type="number" min="0" name="expectedAttendance" value={value.expectedAttendance} onChange={change} /></Field>
      <Field label="Source"><Text name="source" value={value.source} onChange={change} /></Field>
      <Field label="Source URL" error={errors.sourceUrl}><Text type="url" name="sourceUrl" value={value.sourceUrl} onChange={change} /></Field>
      <label className="flex items-center gap-3 self-center text-sm font-medium"><input type="checkbox" name="active" checked={value.active} onChange={change} className="h-4 w-4 accent-[#b41f1f]" />Active</label>
      <Field label="Notes"><textarea className={`${control} min-h-24`} name="notes" value={value.notes} onChange={change} /></Field>
    </div></section>
  </div>;
}
