// A 0.4 s, 440 Hz tone as a standard Ogg Opus file (mono, 20 ms packets), made with
// `ffmpeg -f lavfi -i sine=frequency=440:sample_rate=16000:duration=0.4 -c:a libopus -b:a 12k`.
// A file from a standard encoder and muxer keeps the reader and decoder honest about the format,
// rather than only agreeing with the writer that lives next to them.
const BASE64 = [
  "T2dnUwACAAAAAAAAAAAAAAAAAAAAAEkq9qABE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAAAAAAAABAAAASZW+VAEuT3B1c1RhZ3MG",
  "AAAAZmZtcGVnAQAAABQAAABlbmNvZGVyPUxhdmMgbGlib3B1c09nZ1MABDhMAAAAAAAAAAAAAAIAAACJ3M+dFTMtLComJywxJiUpKSooKCsoISQf",
  "GEiCW11sVrf0AAF8CJo7avldVgATl6MudD/ilDI9rz25K6cr7Asko5x+U6MYgDj4ut+eAUikiFesmIUDXCYJkjcB2q6UiBhxWX8hD00fXr/4Hdw3",
  "o/tYOmBckcSDCJgk/0icG1JTqkhOk0R+jBdvERx776SEltnrQDSKbqr3lQCPV/0jLCaMeJ+TO6aISJwbUlbOH+se5MUZLgT1Ylb1nxHT/ZR9qscM",
  "6iZZ2mys+CEHqR8PBXb2SJwbn3Wc/EkO1/vj6lmve0BUUutnNp0/+ZKxQ6aMMPDCduqW/qBInBtXUV8mJStI92KgHl6V2AK/lqSQfOjiwzt6forC",
  "cedjTBoNlthInBtRtBy/qJg+R3KJcZ0TwNhl75UwDNckvcTe6sUtceTVmoeYgw8yZORpLUicG1JWziN2e5LDVyoNqF+VkiKYd1Ma5KEWIA2oWLA3",
  "77lAQvKrB7pc6PAyH4vfCYBInBtSVs4f6x7IKQrETjc0X0HbJuqapUv6eTNDiUkBbIixFHNHXEicG591nPxJM7+ZMVKPHfEopwOIbQVZZl2jDS7+",
  "TjXj9y3FPcBInBtXS922mCNnhsWmUW3Cf/bS19+9Zv3G/3GLmamri2q0KCPKgoKoMEick5JWziIqNxxrryo9g84J6Y1ShPjSTLejFWPHkgIMgeKx",
  "aKmFHUyUSJyTklbOI3Z7dUoUusrAGh/MpciMz4yoo6inneBhdujaU2BDr9RT96mASJyTklbOIil/JdbnJGynNntwtmAoEDRo/hDzU5zB1Bq+1nU7",
  "zOJBwEick5JWziIbL8Vu/Kp45uZcZnBV4t6ZDs9gEjNZixruKDV434WVu8BInJOXZtpXLtCzgKjO3NU5FbnfayaPnVPR9gu76dM8u5GSPfzQ0P4B",
  "T45gSJycF8E6U494dj5v9SkHTkYw+5Gbtnv+Hv6DYMnm/jWvJmwdHhrVQEidaPl4XIvjc6HTev71MguooIrCXcDo+EwYFWqIPAdJ8EidaQdLfmMO",
  "nWJ6DTJMvRuce5l0ssSV8Meq/i0hilJqQO0/EEidaPl4XIgwRKDfRqtewfSYuV0X8115Bs4OsNafNEBIBiamg80eGsGojInZx5sECytmaWea+0A=",
].join("");

export function oggOpusToneFixture(): Uint8Array<ArrayBuffer> {
  const binary = atob(BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const OGG_OPUS_TONE_SECONDS = 0.4;
