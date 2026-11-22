// React Router reads TextEncoder when it loads; Jest 27's jsdom environment doesn't define it.
import { TextEncoder, TextDecoder } from 'util';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
