// Types resolve to upstream react-native; Metro swaps in react-native-macos
// at runtime. Declare the macOS-only props this app uses.
import "react-native";

declare module "react-native" {
  interface TextInputProps {
    /** macOS: draw the system focus ring around the field. */
    enableFocusRing?: boolean;
  }
}
