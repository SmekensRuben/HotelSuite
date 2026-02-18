import { useContext, useEffect, useState } from "react";
import { useBeforeUnload, UNSAFE_NavigationContext } from "react-router-dom";

export default function useConfirmOnLeave(when) {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const [isBlocked, setIsBlocked] = useState(false);
  const [tx, setTx] = useState(null);
  const [unblock, setUnblock] = useState(() => () => {});

  useEffect(() => {
    if (!when) return;

    // React Router v7 removed the "block" method from navigators. Guard against
    // its absence so that adding products to an order doesn't crash the app with
    // "navigator.block is not a function" errors.
    if (typeof navigator.block !== "function") return;

    const unblockFunc = navigator.block(transition => {
      setIsBlocked(true);
      setTx(transition);
    });

    setUnblock(() => unblockFunc);
    return () => unblockFunc();
  }, [navigator, when]);

  useBeforeUnload(
    when
      ? event => {
          event.preventDefault();
          event.returnValue = "";
        }
      : null
  );

  const confirm = () => {
    setIsBlocked(false);
    unblock();
    if (tx) {
      tx.retry();
      setTx(null);
    }
  };

  const cancel = () => {
    setIsBlocked(false);
  };

  return { isBlocked, confirm, cancel };
}
