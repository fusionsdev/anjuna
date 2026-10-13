import { configure } from "@testing-library/react";

// A loaded CI runner took up to 3.4 s (measured, 48 busy loops on 32 cores) to render the first brand and finish its history
// recovery; the 1000 ms default failed the first test of a file. The longer budget only affects waits that fail anyway.
configure({ asyncUtilTimeout: 5000 });
