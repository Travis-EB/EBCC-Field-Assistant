// Mobilization checklists for the per-job action-item board. Kept identical
// to BOARD_TEMPLATES in public/index.html — the client shows them, the server
// inserts them (mode:'addTemplate'), so both must agree on the text.
const BOARD_TEMPLATES = {
  '1st move': [
    'Plans sent to the model guys',
    'Job book created',
    'Walk the site with the superintendent',
    'Bench the building',
    'Finished floor on the pad confirmed with the PM',
    'Lime scheduled (note the date)',
    'Erosion control in place',
  ],
  '2nd move': [
    'Walk with the concrete guy before demob',
    'Landscape plans received',
    'Walk with the landscaper before mobilizing',
    'Plan changes checked',
    'Rock / base scheduled',
  ],
  '3rd move': [
    'Backfill curbs',
    'Grade sidewalks',
    'Free-spread topsoil',
    'Final walk with the superintendent',
    'Machines called off / equipment released',
  ],
};

const BOARD_PHASES = ['1st move', '2nd move', '3rd move', 'General'];

module.exports = { BOARD_TEMPLATES, BOARD_PHASES };
