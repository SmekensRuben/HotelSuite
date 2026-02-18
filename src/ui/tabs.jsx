import React, { useState } from "react";

export function Tabs({ children, value, onValueChange, className }) {
  return <div className={className}>{children}</div>;
}

export function TabsList({ children, className }) {
  return <div className={`flex gap-2 border-b pb-1 ${className}`}>{children}</div>;
}

export function TabsTrigger({ value, children }) {
  return (
    <TabsContext.Consumer>
      {({ active, setActive }) => (
        <button
          onClick={() => setActive(value)}
          className={`px-4 py-2 rounded-t border ${
            active === value ? "bg-white border-b-white font-semibold" : "bg-gray-200"
          }`}
        >
          {children}
        </button>
      )}
    </TabsContext.Consumer>
  );
}

export function TabsContent({ value, children }) {
  return (
    <TabsContext.Consumer>
      {({ active }) => (active === value ? <div>{children}</div> : null)}
    </TabsContext.Consumer>
  );
}

// TabsContext wrapper
const TabsContext = React.createContext();

export function TabsWrapper({ value, onValueChange, children, className }) {
  const [active, setActive] = useState(value);
  const changeTab = (v) => {
    setActive(v);
    if (onValueChange) onValueChange(v);
  };

  return (
    <TabsContext.Provider value={{ active, setActive: changeTab }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

// Gebruik deze wrapper in plaats van <Tabs> als je het zelf wil beheren
Tabs.Wrapper = TabsWrapper;
Tabs.List = TabsList;
Tabs.Trigger = TabsTrigger;
Tabs.Content = TabsContent;
