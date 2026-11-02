import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  ComboBox,
  DatePicker,
  DatePickerInput,
  FilterableMultiSelect,
  Modal,
  Select,
  SelectItem,
  TextArea,
  TextInput,
  Tile,
} from "@sortsys/react-components";

const options = [
  { id: "first", label: "First tool with a long descriptive name" },
  { id: "second", label: "Second tool" },
];

export function FormFieldsFixture() {
  const [open, setOpen] = useState(false);
  const [delayed, setDelayed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pageField, setPageField] = useState(false);
  const [dates, setDates] = useState([new Date(2026, 9, 30)]);
  const [selected, setSelected] = useState([]);

  useEffect(() => {
    if (!delayed) {
      setLoaded(false);
      return;
    }

    const timer = setTimeout(() => setLoaded(true), 500);

    return () => clearTimeout(timer);
  }, [delayed]);

  return (
    <Tile role="region" aria-label="Mobile form fields">
      <h2 className="text-xl font-semibold">Mobile form fields</h2>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setOpen(true)}>Open field dialog</Button>
        <Button onClick={() => setDelayed(true)}>Open delayed fields</Button>
        <Button onClick={() => setPageField(true)}>Show page field</Button>
      </div>
      {pageField && <TextInput autoFocus labelText="Page autofocus" />}
      <Modal
        open={open}
        modalHeading="Field dialog"
        closeButtonLabel="Close field dialog"
        onRequestClose={() => setOpen(false)}
        onRequestSubmit={() => setOpen(false)}
      >
        <TextInput autoFocus labelText="First dialog field" />
        <div className="flex gap-2" data-testid="native-date-row">
          <TextInput autoFocus type="date" labelText="From" />
          <TextInput type="date" labelText="To" />
        </div>
        <div className="flex gap-2" data-testid="picker-row">
          <DatePicker value={dates} onChange={setDates}>
            <DatePickerInput labelText="Start date" />
          </DatePicker>
          <DatePicker value={dates} onChange={setDates}>
            <DatePickerInput labelText="End date" />
          </DatePicker>
        </div>
        <div className="flex gap-2" data-testid="mixed-field-row">
          <TextInput type="number" labelText="Hours" defaultValue="8" />
          <Select autoFocus labelText="Unit">
            <SelectItem value="hours" text="Hours" />
            <SelectItem value="days" text="Days" />
          </Select>
        </div>
        <div className="flex gap-2" data-testid="autocomplete-row">
          <ComboBox
            autoFocus
            titleText="Single tool"
            items={options}
            itemToString={(item) => item.label}
          />
          <FilterableMultiSelect
            autoFocus
            titleText="Multiple tools"
            items={options}
            selectedItems={selected}
            onChange={({ selectedItems }) => setSelected(selectedItems)}
            itemToString={(item) => item.label}
          />
        </div>
        <TextArea autoFocus labelText="Dialog comment" rows={2} />
        <Checkbox autoFocus labelText="Dialog checkbox" />
      </Modal>
      <Modal
        open={delayed}
        modalHeading="Delayed field dialog"
        closeButtonLabel="Close delayed fields"
        onRequestClose={() => setDelayed(false)}
        passiveModal
      >
        {loaded ? (
          <TextInput autoFocus labelText="Loaded dialog field" />
        ) : (
          <p role="status">Loading fixture fields</p>
        )}
      </Modal>
    </Tile>
  );
}
