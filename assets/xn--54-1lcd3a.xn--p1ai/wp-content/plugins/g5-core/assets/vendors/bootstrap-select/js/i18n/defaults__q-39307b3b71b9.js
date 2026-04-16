/*!
 * Bootstrap-select v1.13.14 (https://developer.snapappointments.com/bootstrap-select)
 *
 * Copyright 2012-2020 SnapAppointments, LLC
 * Licensed under MIT (https://github.com/snapappointments/bootstrap-select/blob/master/LICENSE)
 */

(function (root, factory) {
  if (root === undefined && window !== undefined) root = window;
  if (typeof define === 'function' && define.amd) {
    // AMD. Register as an anonymous module unless amdModuleId is set
    define(["jquery"], function (a0) {
      return (factory(a0));
    });
  } else if (typeof module === 'object' && module.exports) {
    // Node. Does not work with strict CommonJS, but
    // only CommonJS-like environments that support module.exports,
    // like Node.
    module.exports = factory(require("jquery"));
  } else {
    factory(root["jQuery"]);
  }
}(this, function (jQuery) {

  (function ($) {
    $.fn.selectpicker.defaults = {
      noneSelectedText: bootstrap_select_i18n.noneSelectedText,
      noneResultsText: bootstrap_select_i18n.noneResultsText,
      countSelectedText: function (numSelected, numTotal) {
        return (numSelected == 1) ? bootstrap_select_i18n.countSelectedText.single : bootstrap_select_i18n.countSelectedText.multi;
      },
      maxOptionsText: function (numAll, numGroup) {
        return [
          (numAll == 1) ? bootstrap_select_i18n.maxOptionsText.numAll.single : bootstrap_select_i18n.maxOptionsText.numAll.multi,
          (numGroup == 1) ? bootstrap_select_i18n.maxOptionsText.numGroup.single : bootstrap_select_i18n.maxOptionsText.numGroup.multi
        ];
      },
      selectAllText: bootstrap_select_i18n.selectAllText,
      deselectAllText: bootstrap_select_i18n.deselectAllText,
      doneButtonText: bootstrap_select_i18n.doneButtonText,
      multipleSeparator: bootstrap_select_i18n.multipleSeparator
    };
  })(jQuery);


}));
//# sourceMappingURL=defaults-en_US.js.map