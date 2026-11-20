import { createContext, useContext } from "react";

/** True in a compared chat the user has not decided yet, so turn details don't name the model. */
export const ModelHiddenContext = createContext(false);

export function useModelHidden(): boolean {
  return useContext(ModelHiddenContext);
}
