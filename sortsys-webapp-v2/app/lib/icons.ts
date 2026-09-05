import Add from "@carbon/icons-react/es/Add";
import AddAlt from "@carbon/icons-react/es/AddAlt";
import ArrowLeft from "@carbon/icons-react/es/ArrowLeft";
import Box from "@carbon/icons-react/es/Box";
import Chat from "@carbon/icons-react/es/Chat";
import Camera from "@carbon/icons-react/es/Camera";
import Catalog from "@carbon/icons-react/es/Catalog";
import Checkmark from "@carbon/icons-react/es/Checkmark";
import ChevronDown from "@carbon/icons-react/es/ChevronDown";
import ChevronRight from "@carbon/icons-react/es/ChevronRight";
import CircleSolid from "@carbon/icons-react/es/CircleSolid";
import Close from "@carbon/icons-react/es/Close";
import CloseOutline from "@carbon/icons-react/es/CloseOutline";
import Code from "@carbon/icons-react/es/Code";
import ContinueFilled from "@carbon/icons-react/es/ContinueFilled";
import CurrencyEuro from "@carbon/icons-react/es/CurrencyEuro";
import DataDefinition from "@carbon/icons-react/es/DataDefinition";
import Document from "@carbon/icons-react/es/Document";
import DocumentMultiple_01 from "@carbon/icons-react/es/DocumentMultiple_01";
import Download from "@carbon/icons-react/es/Download";
import Edit from "@carbon/icons-react/es/Edit";
import Email from "@carbon/icons-react/es/Email";
import Filter from "@carbon/icons-react/es/Filter";
import FilterEdit from "@carbon/icons-react/es/FilterEdit";
import FilterRemove from "@carbon/icons-react/es/FilterRemove";
import Home from "@carbon/icons-react/es/Home";
import Identification from "@carbon/icons-react/es/Identification";
import InformationFilled from "@carbon/icons-react/es/InformationFilled";
import Locked from "@carbon/icons-react/es/Locked";
import Logout from "@carbon/icons-react/es/Logout";
import MagicWandFilled from "@carbon/icons-react/es/MagicWandFilled";
import OrderDetails from "@carbon/icons-react/es/OrderDetails";
import OverflowMenuVertical from "@carbon/icons-react/es/OverflowMenuVertical";
import Password from "@carbon/icons-react/es/Password";
import Phone from "@carbon/icons-react/es/Phone";
import Pin from "@carbon/icons-react/es/Pin";
import PinFilled from "@carbon/icons-react/es/PinFilled";
import Redo from "@carbon/icons-react/es/Redo";
import Report from "@carbon/icons-react/es/Report";
import Reset from "@carbon/icons-react/es/Reset";
import RuleLocked from "@carbon/icons-react/es/RuleLocked";
import Search from "@carbon/icons-react/es/Search";
import Settings from "@carbon/icons-react/es/Settings";
import TableSplit from "@carbon/icons-react/es/TableSplit";
import TagGroup from "@carbon/icons-react/es/TagGroup";
import TaskComplete from "@carbon/icons-react/es/TaskComplete";
import TaskTools from "@carbon/icons-react/es/TaskTools";
import ToolKit from "@carbon/icons-react/es/ToolKit";
import TrashCan from "@carbon/icons-react/es/TrashCan";
import Undo from "@carbon/icons-react/es/Undo";
import Unlocked from "@carbon/icons-react/es/Unlocked";
import UpdateNow from "@carbon/icons-react/es/UpdateNow";
import Upload from "@carbon/icons-react/es/Upload";
import User from "@carbon/icons-react/es/User";

export type Icon = (typeof Icons)[keyof typeof Icons];

export const Icons = {
    Info: InformationFilled,
    
    Project: Catalog,
    Tool: ToolKit,
    User: User,
    Product: DataDefinition,
    ProductVendor: TagGroup,
    Customer: OrderDetails,
    Contact: Identification,
    DeliveryNote: DocumentMultiple_01,
    Camera: Camera,
    Upload: Upload,
    PriceRecord: CurrencyEuro,
    RegieReport: Document,
    DailyReport: Report,

    Dashboard: Home,
    Settings: Settings,
    Script: Code,
    Chat: Chat,

    Create: AddAlt,
    Edit: Edit,
    Delete: TrashCan,

    Logout: Logout,

    Track: UpdateNow,
    TakeBack: Undo,
    Transfer: Redo,

    Magic: MagicWandFilled,

    Archive: Box,
    UndoArchive: Box,
    Finish: TaskComplete,
    Resume: ContinueFilled,

    DropdownMenu: OverflowMenuVertical,

    ToolInventory: TaskTools,

    Circle: CircleSolid,

    Filter: Filter,
    FilterEdit: FilterEdit,
    FilterRemove: FilterRemove,

    Plus: Add,
    Pin: Pin,
    PinFilled: PinFilled,
    Back: ArrowLeft,

    AccordionClosed: ChevronRight,
    AccordionExpanded: ChevronDown,

    Excel: TableSplit,

    Accept: Checkmark,
    Deny: Close,

    Lock: Locked,
    Unlock: Unlocked,
    
    Disable: CloseOutline,
    SetPassword: Password,

    Role: RuleLocked,
    EditRole: RuleLocked,

    Email: Email,
    Phone: Phone,

    Search: Search,
    Close: Close,
    Reset: Reset,
    Download: Download,
} as const;
