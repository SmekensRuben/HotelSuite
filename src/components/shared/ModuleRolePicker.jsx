import React from "react";
import { MODULE_CATALOG } from "../../constants/moduleCatalog";

export default function ModuleRolePicker({ modules = [], value = {}, onChange, disabled = false }) {
  return <fieldset disabled={disabled} className="space-y-4">
    <legend className="mb-3 text-sm font-semibold">Module roles</legend>
    {modules.map((id) => {
      const module = MODULE_CATALOG[id];
      if (!module) return null;
      const roles = value[id] || [];
      return <div key={id} className="rounded-xl border border-slate-200 p-4">
        <h3 className="text-sm font-semibold">{module.label}</h3>
        {Object.keys(module.roles).length ? <div className="mt-3 flex flex-wrap gap-4">
          {Object.entries(module.roles).map(([roleId, role]) => <label key={roleId} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={roles.includes(roleId)} onChange={() => onChange({ ...value,
              [id]: roles.includes(roleId) ? roles.filter((key) => key !== roleId) : [...roles, roleId] })} />{role.label}
          </label>)}
        </div> : <p className="mt-2 text-xs text-slate-500">Use advanced permissions for this module. Role presets will be introduced when its module is developed.</p>}
      </div>;
    })}
    <p className="text-xs leading-5 text-slate-500">Combine roles when needed. Approvers also need an outlet assignment. Module Manager does not automatically approve orders. Stock Controller manages stock counts; supplier-order receiving is a separate workflow.</p>
  </fieldset>;
}
