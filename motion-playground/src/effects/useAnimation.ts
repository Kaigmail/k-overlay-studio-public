import { createContext, useEffect, useState } from "react";

export const FxSpeedContext = createContext(1);

/**
 * 进场开关。playToken 变化时先置为 false,下一帧置 true,
 * 从而重新触发 CSS 过渡(用于 mask 揭示 / 淡入 / 位移)。
 */
export function useEnter(playToken: number): boolean {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    setEntered(false);
    // 两层 rAF 都要记下来取消。以前只取消外层:连着重放时(playToken 快速连变)
    // 上一轮的内层回调已经排上了队,cleanup 拦不住它,于是它在新一轮刚 setEntered(false)
    // 之后立刻又置回 true —— 那张卡的进场动画整个被吃掉,直接显示成已进场的样子。
    // 绝大多数卡走这个钩子,连按空格重放最容易撞上。
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, [playToken]);
  return entered;
}
